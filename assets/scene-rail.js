import * as THREE from 'three';

// Scene layout, in world units. The camera sees roughly 5.4 units of height at z = 0.
const RAIL_Y = 1.75;
const GARMENT_HEIGHT = 3.1;
const SPACING = 2.05;
const FOCUS_Z = 1.6;
const TEXTURE_WIDTH = 640;

const damp = (current, target, speed, dt) => current + (target - current) * (1 - Math.exp(-speed * dt));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Removes the flat studio background from a product photo by flood-filling from the image border,
 * so a garment shot on white or light grey hangs on the rail as a cut-out.
 * Returns a canvas plus an alpha lookup used for precise pointer hit testing.
 */
function cutOut(image) {
  const width = Math.min(TEXTURE_WIDTH, image.naturalWidth);
  const height = Math.round((width / image.naturalWidth) * image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);

  let data;
  try {
    data = ctx.getImageData(0, 0, width, height);
  } catch (error) {
    // Cross-origin image without CORS headers: use it as is.
    return { canvas, alpha: null, width, height };
  }
  const px = data.data;

  // Background colour = average of the four corners.
  const bg = [0, 0, 0];
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  corners.forEach((i) => {
    bg[0] += px[i * 4] / 4;
    bg[1] += px[i * 4 + 1] / 4;
    bg[2] += px[i * 4 + 2] / 4;
  });
  const distance = (i) => {
    const r = px[i * 4] - bg[0];
    const g = px[i * 4 + 1] - bg[1];
    const b = px[i * 4 + 2] - bg[2];
    return Math.sqrt(r * r + g * g + b * b);
  };

  // A pixel joins the background if it is close to the corner colour and differs only a little from
  // the neighbour it was reached from, so soft gradients and vignettes are removed but garment edges stop the fill.
  const tolerance = 60;
  const step = 14;
  const stepDistance = (a, b) =>
    Math.abs(px[a * 4] - px[b * 4]) + Math.abs(px[a * 4 + 1] - px[b * 4 + 1]) + Math.abs(px[a * 4 + 2] - px[b * 4 + 2]);
  const removed = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const visit = (i, from = i) => {
    if (removed[i] || distance(i) > tolerance || stepDistance(i, from) > step) return;
    removed[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) visit(i - 1, i);
    if (x < width - 1) visit(i + 1, i);
    if (i >= width) visit(i - width, i);
    if (i < width * (height - 1)) visit(i + width, i);
  }

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (removed[i]) {
      px[i * 4 + 3] = 0;
      continue;
    }
    // Feather pixels on the edge of the cut so the outline is not jagged.
    const x = i % width;
    const edge =
      (x > 0 && removed[i - 1]) ||
      (x < width - 1 && removed[i + 1]) ||
      (i >= width && removed[i - width]) ||
      (i < width * (height - 1) && removed[i + width]);
    if (edge) px[i * 4 + 3] = Math.round(clamp(distance(i) / (tolerance * 2), 0, 1) * 255);
    alpha[i] = px[i * 4 + 3];
  }
  ctx.putImageData(data, 0, 0);
  return { canvas, alpha, width, height };
}

/** Soft drop shadow made from a cut-out's silhouette. */
function shadowFrom(cut) {
  const pad = 40;
  const canvas = document.createElement('canvas');
  canvas.width = cut.width + pad * 2;
  canvas.height = cut.height + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'blur(18px)';
  ctx.drawImage(cut.canvas, pad, pad);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, scale: canvas.width / cut.width };
}

function priceTag(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(4, 4, 184, 88, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = '600 38px system-ui, -apple-system, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.replace(/\.00(?=\D*$)/, ''), 96, 50, 170);
  return canvas;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

class SceneRail extends HTMLElement {
  connectedCallback() {
    this.products = JSON.parse(this.querySelector('[data-products]').textContent || '[]');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!this.products.length || reducedMotion || !this.supportsWebGL()) return;

    this.classList.add('is-3d');
    this.stage = this.querySelector('[data-stage]');
    this.panel = this.querySelector('[data-panel]');
    this.items = [];
    this.offset = 0;
    this.targetOffset = 0;
    this.velocity = 0;
    this.selected = null;
    this.hovered = null;
    this.clock = new THREE.Clock();

    this.setUpScene();
    this.setUpPanel();
    this.bindPointer();
    this.loadProducts();

    this.visible = true;
    this.observer = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.clock.getDelta();
    });
    this.observer.observe(this.stage);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  disconnectedCallback() {
    if (!this.renderer) return;
    this.renderer.setAnimationLoop(null);
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
  }

  supportsWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
    } catch (error) {
      return false;
    }
  }

  setUpScene() {
    const canvas = this.querySelector('[data-canvas]');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 0.2, 10);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);

    this.rail = new THREE.Group();
    this.scene.add(this.rail);

    const length = Math.max(this.products.length - 1, 1) * SPACING + 60;
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, length, 16),
      new THREE.MeshBasicMaterial({ color: 0x2a2a2a }),
    );
    bar.rotation.z = Math.PI / 2;
    bar.position.set(((this.products.length - 1) * SPACING) / 2, RAIL_Y, 0);
    this.rail.add(bar);

    const highlight = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, length, 8),
      new THREE.MeshBasicMaterial({ color: 0x8a8a8a }),
    );
    highlight.rotation.z = Math.PI / 2;
    highlight.position.set(bar.position.x, RAIL_Y + 0.02, 0.03);
    this.rail.add(highlight);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.stage;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Pull the camera back on narrow screens so a garment still fits.
    this.camera.position.z = width < 750 ? 13.5 : 10;
    this.camera.updateProjectionMatrix();
    this.isNarrow = width < 750;
    if (!this.started) {
      this.started = true;
      this.offset = this.targetOffset = this.browseRange()[0];
    } else {
      this.setTarget(this.targetOffset, !!this.selected);
    }
  }

  async loadProducts() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.products.forEach((product, index) => {
      const pivot = new THREE.Group();
      pivot.position.set(index * SPACING, RAIL_Y + 0.14, 0);
      this.rail.add(pivot);

      const body = new THREE.Group();
      pivot.add(body);

      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      body.add(mesh);

      const shadowMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
      const shadow = new THREE.Mesh(geometry, shadowMaterial);
      shadow.position.z = -0.25;
      pivot.add(shadow);

      const tag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, 0.21),
        new THREE.MeshBasicMaterial({ map: canvasTexture(priceTag(product.price)), transparent: true, opacity: 0 }),
      );
      tag.position.set(0.05, -0.32, 0.02);
      tag.rotation.z = -0.08;
      body.add(tag);

      const item = {
        index,
        product,
        pivot,
        body,
        mesh,
        shadow,
        tag,
        angle: (Math.random() - 0.5) * 0.06,
        angularVelocity: 0,
        phase: Math.random() * Math.PI * 2,
        swayResponse: 0.8 + Math.random() * 0.5,
        z: 0,
        scale: 1,
        opacity: 0,
        flip: 0,
        showingBack: false,
        ready: false,
      };
      mesh.userData.item = item;
      this.items.push(item);
    });

    // Front images first so the rail fills quickly; back views load afterwards.
    await Promise.all(this.items.map((item) => this.loadFront(item)));
    this.items.forEach((item) => this.loadBack(item));
  }

  async loadFront(item) {
    try {
      const cut = cutOut(await loadImage(item.product.front));
      const aspect = cut.width / cut.height;
      item.aspect = aspect;
      item.alpha = cut.alpha;
      item.alphaSize = [cut.width, cut.height];
      item.frontTexture = canvasTexture(cut.canvas);
      item.mesh.material.map = item.frontTexture;
      item.mesh.material.needsUpdate = true;
      item.mesh.scale.set(GARMENT_HEIGHT * aspect, GARMENT_HEIGHT, 1);
      item.mesh.position.y = -GARMENT_HEIGHT / 2;
      item.tag.position.x = GARMENT_HEIGHT * aspect * 0.18;

      const shadow = shadowFrom(cut);
      item.shadow.material.map = canvasTexture(shadow.canvas);
      item.shadow.material.needsUpdate = true;
      item.shadow.scale.set(GARMENT_HEIGHT * aspect * shadow.scale, GARMENT_HEIGHT * shadow.scale, 1);
      item.shadow.position.set(0.12, -GARMENT_HEIGHT / 2 - 0.08, -0.25);
      item.ready = true;
    } catch (error) {
      console.warn('[scene-rail] Could not load', item.product.front, error);
    }
  }

  async loadBack(item) {
    if (!item.product.back || item.product.back === item.product.front) return;
    try {
      const cut = cutOut(await loadImage(item.product.back));
      const texture = canvasTexture(cut.canvas);
      // The back face is seen through the plane, so mirror it to read correctly.
      texture.wrapS = THREE.RepeatWrapping;
      texture.repeat.x = -1;
      item.backTexture = texture;
    } catch (error) {
      console.warn('[scene-rail] Could not load', item.product.back, error);
    }
  }

  bindPointer() {
    const stage = this.stage;
    let start = null;
    let last = 0;

    stage.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY, offset: this.targetOffset, moved: false };
      last = event.clientX;
      stage.setPointerCapture(event.pointerId);
    });

    stage.addEventListener('pointermove', (event) => {
      const rect = stage.getBoundingClientRect();
      this.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > 6) {
        start.moved = true;
        stage.classList.add('is-dragging');
        if (this.selected) this.deselect();
      }
      if (start.moved) {
        const unitsPerPixel = this.visibleWidth() / rect.width;
        this.setTarget(this.targetOffset - (event.clientX - last) * unitsPerPixel * 1.2);
      }
      last = event.clientX;
    });

    const end = (event) => {
      if (!start) return;
      if (!start.moved && event.type === 'pointerup') this.handleClick();
      stage.classList.remove('is-dragging');
      start = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', () => this.pointer.set(-10, -10));

    stage.addEventListener(
      'wheel',
      (event) => {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        const [min, max] = this.browseRange();
        const next = clamp(this.targetOffset + delta * 0.006, min, max);
        // Let the page scroll once the rail reaches either end.
        if (next === this.targetOffset) return;
        event.preventDefault();
        if (this.selected) this.deselect();
        this.setTarget(next);
      },
      { passive: false },
    );

    stage.tabIndex = 0;
    stage.setAttribute('role', 'region');
    stage.setAttribute('aria-label', 'Clothing rail. Use the arrow keys to browse and Enter to open a product.');
    stage.addEventListener('keydown', (event) => {
      const current = this.selected ? this.selected.index : Math.round(this.targetOffset / SPACING);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = clamp(current + (event.key === 'ArrowRight' ? 1 : -1), 0, this.items.length - 1);
        if (this.selected) this.select(this.items[next]);
        else this.setTarget(next * SPACING, true);
      } else if (event.key === 'Enter') {
        this.select(this.items[current]);
      } else if (event.key === 'Escape') {
        this.deselect();
      }
    });
  }

  visibleWidth() {
    const height = 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return height * this.camera.aspect;
  }

  maxOffset() {
    return (this.products.length - 1) * SPACING;
  }

  // Browsing keeps the rail filling the screen; opening a product may still centre the first or last one.
  browseRange() {
    const max = this.maxOffset();
    const inset = Math.max(this.visibleWidth() / 2 - SPACING * 0.75, 0);
    return inset * 2 >= max ? [max / 2, max / 2] : [inset, max - inset];
  }

  setTarget(value, free = false) {
    const [min, max] = free ? [0, this.maxOffset()] : this.browseRange();
    this.targetOffset = clamp(value, min, max);
    this.querySelector('[data-hint]').classList.add('is-hidden');
  }

  hitTest() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.items.filter((item) => item.ready).map((item) => item.mesh),
      false,
    );
    // Ignore clicks on the transparent area around a garment.
    const hit = hits.find(({ object, uv }) => {
      const { alpha, alphaSize } = object.userData.item;
      if (!alpha || !uv) return true;
      const x = Math.floor(uv.x * (alphaSize[0] - 1));
      const y = Math.floor((1 - uv.y) * (alphaSize[1] - 1));
      return alpha[y * alphaSize[0] + x] > 40;
    });
    return hit?.object.userData.item ?? null;
  }

  handleClick() {
    const item = this.hitTest();
    if (item && item !== this.selected) this.select(item);
    else if (!item && this.selected) this.deselect();
  }

  // ----- Detail panel -----

  setUpPanel() {
    const panel = this.panel;
    this.panelEls = {
      count: panel.querySelector('[data-count]'),
      title: panel.querySelector('[data-title]'),
      price: panel.querySelector('[data-price]'),
      sizes: panel.querySelector('[data-sizes]'),
      add: panel.querySelector('[data-add]'),
      error: panel.querySelector('[data-error]'),
      link: panel.querySelector('[data-link]'),
      views: panel.querySelectorAll('[data-view]'),
    };
    panel.querySelector('[data-close]').addEventListener('click', () => this.deselect());
    this.panelEls.views.forEach((button) =>
      button.addEventListener('click', () => this.showSide(button.dataset.view === 'back')),
    );
    this.panelEls.add.addEventListener('click', () => this.addToCart());
  }

  select(item) {
    if (!item) return;
    if (this.selected && this.selected !== item) this.selected.flip = 0;
    this.selected = item;
    this.setTarget(item.index * SPACING, true);

    const { product } = item;
    const els = this.panelEls;
    const pad = (n) => String(n).padStart(2, '0');
    els.count.textContent = `${pad(item.index + 1)} / ${pad(this.items.length)}`;
    els.title.textContent = product.title;
    els.price.textContent = product.price;
    els.link.href = product.url;
    els.error.hidden = true;
    els.add.textContent = 'Add to cart';
    this.setSideButtons(false);

    els.sizes.replaceChildren(
      ...product.variants.map((variant) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = variant.size || 'One size';
        button.disabled = !variant.available;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => this.chooseVariant(variant.id));
        button.dataset.variant = variant.id;
        return button;
      }),
    );
    const firstAvailable = product.variants.find((variant) => variant.available);
    this.chooseVariant(firstAvailable?.id ?? null);
    this.panel.hidden = false;
    this.classList.add('has-selection');
  }

  deselect() {
    if (!this.selected) return;
    this.selected.flip = 0;
    this.selected.showingBack = false;
    this.selected = null;
    this.panel.hidden = true;
    this.classList.remove('has-selection');
  }

  chooseVariant(id) {
    this.variantId = id;
    this.panelEls.sizes.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.variant) === id));
    });
    this.panelEls.add.disabled = !id;
    if (!id) this.panelEls.add.textContent = 'Sold out';
  }

  setSideButtons(back) {
    this.panelEls.views.forEach((button) =>
      button.classList.toggle('is-active', (button.dataset.view === 'back') === back),
    );
  }

  showSide(back) {
    if (!this.selected) return;
    this.selected.flip = back ? Math.PI : 0;
    this.setSideButtons(back);
  }

  async addToCart() {
    if (!this.variantId) return;
    const { add, error } = this.panelEls;
    add.disabled = true;
    add.textContent = 'Adding…';
    error.hidden = true;

    const cartDrawer = document.querySelector('cart-drawer');
    const body = { items: [{ id: this.variantId, quantity: 1 }] };
    if (cartDrawer) {
      body.sections = cartDrawer.getSectionsToRender().map((section) => section.id);
      body.sections_url = window.location.pathname;
    }

    try {
      const root = window.Shopify?.routes?.root ?? '/';
      const response = await fetch(`${root}cart/add.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.status)
        throw new Error(json.description || 'Could not add this item to the cart. Please try again.');

      add.textContent = 'Added ✓';
      if (cartDrawer) {
        cartDrawer.classList.remove('is-empty');
        cartDrawer.renderContents({ ...json, id: this.variantId });
      } else {
        document.dispatchEvent(new CustomEvent('scene-rail:added', { detail: json }));
      }
    } catch (err) {
      add.textContent = 'Add to cart';
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      add.disabled = false;
    }
  }

  // ----- Animation loop -----

  tick() {
    if (!this.visible) return;
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    const time = this.clock.elapsedTime;

    const previous = this.offset;
    this.offset = damp(this.offset, this.targetOffset, 6, dt);
    this.velocity = (this.offset - previous) / Math.max(dt, 1e-4);

    // Keep the open garment left of centre so the panel has room on desktop.
    const panelShift = this.selected && !this.isNarrow ? -1.7 : 0;
    this.railShift = damp(this.railShift ?? 0, panelShift, 5, dt);
    this.rail.position.x = -this.offset + this.railShift;
    // On phones the panel covers the lower half, so lift the scene while it is open.
    const cameraY = this.isNarrow ? (this.selected ? -1.9 : -0.9) : 0.2;
    this.camera.position.y = damp(this.camera.position.y, cameraY, 5, dt);

    const max = this.maxOffset();
    const progress = this.querySelector('[data-progress]');
    if (progress) progress.style.transform = `translateX(${(max ? this.offset / max : 0) * 233}%)`;

    const hovered = this.selected ? null : this.hitTest();
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.stage.classList.toggle('is-hovering', !!hovered);
    }

    this.items.forEach((item) => this.updateItem(item, dt, time));
    this.renderer.render(this.scene, this.camera);
  }

  updateItem(item, dt, time) {
    // Hanger swing: a damped spring pushed by how fast the rail is moving.
    const idle = Math.sin(time * 0.9 + item.phase) * 0.012;
    const force = -this.velocity * 0.09 * item.swayResponse;
    item.angularVelocity += (-(item.angle - idle) * 26 + force - item.angularVelocity * 3.2) * dt;
    item.angle += item.angularVelocity * dt;
    item.pivot.rotation.z = clamp(item.angle, -0.5, 0.5);

    const isSelected = item === this.selected;
    const isHovered = item === this.hovered;
    item.z = damp(item.z, isSelected ? FOCUS_Z : isHovered ? 0.35 : 0, 6, dt);
    item.scale = damp(item.scale, isHovered ? 1.04 : 1, 8, dt);
    const targetOpacity = item.ready ? (this.selected && !isSelected ? 0.25 : 1) : 0;
    item.opacity = damp(item.opacity, targetOpacity, 5, dt);

    item.pivot.position.z = item.z;
    item.body.scale.setScalar(item.scale);
    item.mesh.material.opacity = item.opacity;
    item.tag.material.opacity = item.opacity * (isSelected ? 0 : 1);
    item.shadow.material.opacity = item.opacity * 0.16 * (1 - item.z / (FOCUS_Z * 2));

    // Front/back turn: swap to the back photo once the plane is edge-on.
    item.body.rotation.y = damp(item.body.rotation.y, item.flip, 7, dt);
    const showBack = item.body.rotation.y > Math.PI / 2;
    if (showBack !== item.showingBack) {
      item.showingBack = showBack;
      item.mesh.material.map = showBack && item.backTexture ? item.backTexture : item.frontTexture;
      item.mesh.material.needsUpdate = true;
    }
  }
}

customElements.define('scene-rail', SceneRail);
