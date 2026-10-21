(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = (amount) => new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0
  }).format(Number(amount) || 0);
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const safeImage = (value) => {
    const image = String(value || '');
    if (/^\/static\/assets\/[a-z0-9-]+\.svg$/i.test(image) || /^\/uploads\/[a-f0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(image)) return image;
    return '/static/assets/baby-tee.svg';
  };

  let currentUser = null;
  let csrfToken = '';
  let catalog = [];
  let activeCategory = '';
  let searchTerm = '';
  let sizeFilter = '';
  let sortFilter = 'newest';
  let showAllProducts = false;
  let modalReturnFocus = null;
  let pendingAction = '';
  let authMode = 'login';
  let quizIndex = 0;
  let quizAnswers = [];
  let quizCategory = 'Atasan';
  let isSpeaking = false;
  let speechUtterance = null;
  let cart = readStorage('vestige-cart', []);
  let favorites = new Set(readStorage('vestige-favorites', []));

  const fallbackProducts = [
    { id: -1, title: 'Knit vest warna butter', description: 'Vest rajut warna butter.', price: 68000, category: 'Outerwear', size: 'M', condition: 'Sangat baik', image: '/static/assets/knit-vest.svg', sellerName: '@ranithrift' },
    { id: -2, title: 'Baby tee cherry club', description: 'Baby tee katun dengan grafis cherry.', price: 45000, category: 'Atasan', size: 'S', condition: 'Like new', image: '/static/assets/baby-tee.svg', sellerName: '@vestige.mila' },
    { id: -3, title: 'Denim jeans vintage', description: 'Jeans denim biru dengan potongan relaxed.', price: 89000, category: 'Bawahan', size: 'L', condition: 'Sangat baik', image: '/static/assets/denim-jeans.svg', sellerName: '@secondstory' },
    { id: -4, title: 'Floral midi dress', description: 'Dress motif bunga dengan bahan ringan.', price: 75000, category: 'Dress', size: 'M', condition: 'Baik', image: '/static/assets/floral-dress.svg', sellerName: '@ranithrift' },
  ];

  function readStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function saveStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_error) { /* Private browsing may block storage. */ }
  }

  async function requestJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || 'Ada kendala. Coba lagi, ya.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function toast(message, type = '') {
    const region = $('#toastRegion');
    const item = document.createElement('div');
    item.className = `toast ${type}`.trim();
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 3600);
  }

  function updateHeader() {
    const authButton = $('#authButton');
    if (currentUser) {
      authButton.textContent = `@${currentUser.username}`;
      authButton.setAttribute('aria-label', `Buka akun ${currentUser.username}`);
      authButton.classList.remove('button-outline');
      authButton.classList.add('button-light');
    } else {
      authButton.textContent = 'Masuk';
      authButton.setAttribute('aria-label', 'Masuk atau daftar akun');
      authButton.classList.add('button-outline');
      authButton.classList.remove('button-light');
    }
    $('#cartCount').textContent = String(cart.length);
    $('#cartCount').setAttribute('aria-label', `${cart.length} barang di keranjang`);
  }

  async function init() {
    try {
      const me = await requestJson('/api/me');
      currentUser = me.user;
      csrfToken = me.csrfToken || '';
    } catch (_error) {
      // The storefront still renders its sample catalog if a backend is unavailable.
    }
    updateHeader();
    bindGlobalEvents();
    initRevealAnimations();
    await loadCatalog();
  }

  async function loadCatalog() {
    try {
      const data = await requestJson('/api/products');
      catalog = data.products || [];
      renderProducts();
    } catch (error) {
      catalog = fallbackProducts;
      renderProducts();
      if (!catalog.length) toast(error.message, 'error');
    }
  }

  function getFilteredProducts() {
    const needle = searchTerm.toLocaleLowerCase('id-ID').trim();
    let products = catalog.filter((product) => {
      const matchesCategory = !activeCategory || product.category === activeCategory;
      const matchesSize = !sizeFilter || product.size === sizeFilter;
      const searchable = `${product.title} ${product.description} ${product.category} ${product.sellerName}`.toLocaleLowerCase('id-ID');
      const matchesSearch = !needle || searchable.includes(needle);
      return matchesCategory && matchesSize && matchesSearch;
    });
    if (sortFilter === 'price-low') products.sort((a, b) => a.price - b.price);
    else if (sortFilter === 'price-high') products.sort((a, b) => b.price - a.price);
    else products.sort((a, b) => (b.id || 0) - (a.id || 0));
    return products;
  }

  function renderProducts() {
    const grid = $('#productGrid');
    const products = getFilteredProducts();
    const visible = showAllProducts ? products : products.slice(0, 8);
    $('#resultCount').textContent = `${products.length} temuan ${products.length === 1 ? 'buat kamu' : 'buat kamu'}`;
    $('#clearFilters').hidden = !(activeCategory || searchTerm || sizeFilter || sortFilter !== 'newest');
    const more = $('#showMoreButton');
    more.hidden = products.length <= 8 || showAllProducts;
    more.innerHTML = `Lihat ${Math.max(0, products.length - 8)} temuan lainnya <span aria-hidden="true">↓</span>`;
    if (!visible.length) {
      grid.innerHTML = `<div class="empty-state"><span aria-hidden="true">🧺</span><h3>Belum ada temuan yang cocok.</h3><p>Coba kata kunci atau filter lain, siapa tahu harta karunnya ngumpet.</p><button class="button button-outline" data-action="reset-filters">Lihat semua barang</button></div>`;
      return;
    }
    grid.innerHTML = visible.map((product, index) => productCard(product, index)).join('');
  }

  function productCard(product, index) {
    const isFavorite = favorites.has(product.id);
    const image = safeImage(product.image);
    const seller = escapeHtml(product.sellerName || '@vestigefriend');
    const category = escapeHtml(product.category);
    const isOwnProduct = Boolean(currentUser && product.sellerId === currentUser.id);
    return `<article class="product-card" style="animation-delay:${Math.min(index * 45, 280)}ms" data-product-id="${product.id}">
      <div class="product-image-wrap" role="button" tabindex="0" data-action="details" data-id="${product.id}" aria-label="Lihat detail ${escapeHtml(product.title)}">
        <img src="${image}" alt="Ilustrasi ${escapeHtml(product.title)}" loading="lazy">
        <span class="product-badge">${category}</span>
        <button type="button" class="favorite-button ${isFavorite ? 'favorited' : ''}" data-action="favorite" data-id="${product.id}" aria-label="${isFavorite ? 'Hapus dari favorit' : 'Simpan ke favorit'}" aria-pressed="${isFavorite}">${isFavorite ? '♥' : '♡'}</button>
      </div>
      <div class="product-card-info">
        <div class="product-meta"><span>${escapeHtml(product.size)} · preloved</span><span class="product-condition">${escapeHtml(product.condition)}</span></div>
        <div class="product-title-row"><h3 class="product-title" role="button" tabindex="0" data-action="details" data-id="${product.id}">${escapeHtml(product.title)}</h3></div>
        <p class="product-price">${money(product.price)}</p>
        <div class="product-seller"><span class="seller-dot">${escapeHtml((product.sellerName || 'V').replace('@','').slice(0,1).toUpperCase())}</span> ${seller}</div>
        <button type="button" class="product-quick-add" data-action="add-cart" data-id="${product.id}" ${isOwnProduct ? 'disabled' : ''}>${isOwnProduct ? 'Barang jualanmu' : '＋ Masukkan ke keranjang'}</button>
      </div>
    </article>`;
  }

  function applyFilters() {
    searchTerm = $('#searchInput').value.trim();
    sizeFilter = $('#sizeFilter').value;
    sortFilter = $('#sortFilter').value;
    showAllProducts = false;
    renderProducts();
  }

  function bindGlobalEvents() {
    $('#authButton').addEventListener('click', () => currentUser ? openAccount() : openAuth('login'));
    $('#sellButton').addEventListener('click', openSellModal);
    $('#heroSellButton').addEventListener('click', openSellModal);
    $('#bannerSellButton').addEventListener('click', openSellModal);
    $('#openCart').addEventListener('click', openCart);
    $('#searchForm').addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); $('#katalog').scrollIntoView({ behavior: 'smooth' }); });
    $('#sizeFilter').addEventListener('change', applyFilters);
    $('#sortFilter').addEventListener('change', applyFilters);
    $('#categoryPills').addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (!button) return;
      activeCategory = button.dataset.category || '';
      $$('.category-pill').forEach((pill) => pill.classList.toggle('active', pill === button));
      showAllProducts = false;
      renderProducts();
    });
    $('#clearFilters').addEventListener('click', resetFilters);
    $('#showMoreButton').addEventListener('click', () => { showAllProducts = true; renderProducts(); });
    $('#productGrid').addEventListener('click', handleProductGridClick);
    $('#productGrid').addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-action="details"]')) {
        event.preventDefault(); openProductDetail(Number(event.target.dataset.id));
      }
    });
    $('#startQuizButton').addEventListener('click', startQuiz);
    $('#audioButton').addEventListener('click', toggleAudio);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalOverlay').addEventListener('click', (event) => { if (event.target === $('#modalOverlay')) closeModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#modalOverlay').hidden) closeModal(); });
    $('#mobileMenuButton').addEventListener('click', () => {
      const nav = $('.main-nav');
      const opened = nav.classList.toggle('open');
      $('#mobileMenuButton').setAttribute('aria-expanded', String(opened));
    });
    $$('.main-nav a').forEach((link) => link.addEventListener('click', () => {
      $('.main-nav').classList.remove('open'); $('#mobileMenuButton').setAttribute('aria-expanded', 'false');
    }));
    document.addEventListener('visibilitychange', () => { if (document.hidden && isSpeaking) stopAudio(); });
  }

  function resetFilters() {
    activeCategory = ''; searchTerm = ''; sizeFilter = ''; sortFilter = 'newest'; showAllProducts = false;
    $('#searchInput').value = ''; $('#sizeFilter').value = ''; $('#sortFilter').value = 'newest';
    $$('.category-pill').forEach((pill) => pill.classList.toggle('active', pill.dataset.category === ''));
    renderProducts();
  }

  function handleProductGridClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const id = Number(control.dataset.id);
    if (control.dataset.action === 'favorite') {
      event.stopPropagation();
      toggleFavorite(id);
    } else if (control.dataset.action === 'add-cart') {
      event.stopPropagation();
      const product = catalog.find((item) => item.id === id);
      if (product) addToCart(product);
    } else if (control.dataset.action === 'details') {
      openProductDetail(id);
    } else if (control.dataset.action === 'reset-filters') {
      resetFilters();
    }
  }

  function toggleFavorite(id) {
    if (favorites.has(id)) { favorites.delete(id); toast('Dihapus dari daftar favorit.'); }
    else { favorites.add(id); toast('Disimpan ke favorit. ♡', 'success'); }
    saveStorage('vestige-favorites', [...favorites]);
    renderProducts();
  }

  function addToCart(product) {
    if (cart.some((item) => item.id === product.id)) {
      toast('Barang ini sudah ada di keranjang.');
      return;
    }
    cart.push({ id: product.id, title: product.title, price: product.price, image: safeImage(product.image), category: product.category, sellerName: product.sellerName });
    saveStorage('vestige-cart', cart);
    updateHeader();
    toast('Masuk keranjang! Semoga berjodoh sama outfit kamu. ✨', 'success');
  }

  function removeFromCart(id) {
    cart = cart.filter((item) => item.id !== id);
    saveStorage('vestige-cart', cart);
    updateHeader();
    renderCart();
  }

  function openModal(content, labelledBy = '') {
    modalReturnFocus = document.activeElement;
    $('#modalContent').innerHTML = content;
    $('#modalOverlay').hidden = false;
    document.body.classList.add('modal-open');
    if (labelledBy) $('#modalPanel').setAttribute('aria-labelledby', labelledBy);
    else $('#modalPanel').setAttribute('aria-labelledby', 'modalTitle');
    $('#modalPanel').scrollTop = 0;
    $('#modalPanel').focus({ preventScroll: true });
  }

  function closeModal() {
    if ($('#modalOverlay').hidden) return;
    $('#modalOverlay').hidden = true;
    document.body.classList.remove('modal-open');
    $('#modalContent').innerHTML = '';
    if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') modalReturnFocus.focus({ preventScroll: true });
  }

  function showInlineError(form, message) {
    let error = $('.form-error', form);
    if (!error) {
      error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert');
      form.prepend(error);
    }
    error.textContent = message;
  }

  function openAuth(mode = 'login', inlineMessage = '') {
    authMode = mode;
    const register = authMode === 'register';
    openModal(`<div class="modal-eyebrow">WELCOME TO THE LOOP ♻</div>
      <h2 class="modal-title" id="modalTitle">${register ? 'Yuk, gabung Vestige!' : 'Balik lagi, bestie.'}</h2>
      <p class="modal-subtitle">${register ? 'Satu akun buat menemukan barang unik atau mulai jual barang preloved kamu.' : 'Masuk untuk mengelola barang, menyimpan pesanan, dan mulai jualan.'}</p>
      <div class="auth-tabs"><button type="button" class="auth-tab ${!register ? 'active' : ''}" data-auth-mode="login">Masuk</button><button type="button" class="auth-tab ${register ? 'active' : ''}" data-auth-mode="register">Buat akun</button></div>
      <form class="form-stack" id="authForm" novalidate>
        ${register ? `<div class="form-field"><label for="authUsername">Nama pengguna</label><input id="authUsername" name="username" autocomplete="username" minlength="2" maxlength="32" placeholder="contoh: ayucloset" required></div>` : ''}
        <div class="form-field"><label for="authEmail">Email</label><input id="authEmail" name="email" type="email" autocomplete="email" maxlength="254" placeholder="nama@email.com" required></div>
        <div class="form-field"><label for="authPassword">Kata sandi</label><input id="authPassword" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" placeholder="${register ? 'Minimal 8 karakter' : 'Masukkan kata sandi'}" required></div>
        ${register ? `<div class="form-field"><label>Peran akun</label><div class="role-options"><label class="role-option"><input type="radio" name="role" value="both" checked><span>🛍️ Pembeli + penjual</span></label><label class="role-option"><input type="radio" name="role" value="buyer"><span>♡ Pembeli saja</span></label><label class="role-option"><input type="radio" name="role" value="seller"><span>♻ Penjual saja</span></label></div></div>` : ''}
        ${inlineMessage ? `<p class="form-error" role="alert">${escapeHtml(inlineMessage)}</p>` : ''}
        <button class="button button-primary modal-main-button" type="submit">${register ? 'Buat akun sekarang ↗' : 'Masuk ke akun ↗'}</button>
      </form><p class="auth-footnote">Dengan melanjutkan, kamu setuju menggunakan Vestige secara jujur dan bertanggung jawab.</p>`);
    $$('.auth-tab').forEach((button) => button.addEventListener('click', () => openAuth(button.dataset.authMode)));
    $('#authForm').addEventListener('submit', submitAuth);
    $('#authEmail').focus({ preventScroll: true });
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const isRegister = authMode === 'register';
    const payload = { email: data.get('email'), password: data.get('password') };
    if (isRegister) { payload.username = data.get('username'); payload.role = data.get('role') || 'both'; }
    const button = $('button[type="submit"]', form);
    button.disabled = true; button.textContent = 'Sebentar ya…';
    try {
      const result = await requestJson(isRegister ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(payload) });
      currentUser = result.user; csrfToken = result.csrfToken || '';
      updateHeader(); closeModal();
      toast(`Hai, ${currentUser.username}! ${isRegister ? 'Akunmu sudah siap.' : 'Senang kamu balik lagi.'}`, 'success');
      if (pendingAction === 'sell') {
        pendingAction = '';
        if (currentUser.role === 'buyer') toast('Akun ini disetel sebagai pembeli. Untuk memasang barang, daftar dengan peran penjual atau pembeli + penjual.', 'error');
        else openSellModal();
      } else if (pendingAction === 'checkout') {
        pendingAction = ''; openCheckout();
      }
    } catch (error) {
      button.disabled = false; button.textContent = isRegister ? 'Buat akun sekarang ↗' : 'Masuk ke akun ↗';
      showInlineError(form, error.message);
    }
  }

  function openSellModal() {
    if (!currentUser) {
      pendingAction = 'sell';
      openAuth('register', 'Daftar atau masuk untuk mulai memasang barang.');
      return;
    }
    if (currentUser.role === 'buyer') {
      openAuth('login', 'Akunmu berstatus pembeli. Gunakan akun penjual atau pembeli + penjual untuk memasang barang.');
      return;
    }
    openModal(`<div class="modal-eyebrow">PASS IT ON ♻</div><h2 class="modal-title" id="modalTitle">Pasang barang preloved.</h2><p class="modal-subtitle">Ceritakan kondisi barang dengan jujur, tambahkan foto, lalu barangmu akan muncul di etalase.</p>
      <form id="listingForm" class="form-stack" enctype="multipart/form-data" novalidate>
        <div class="form-field"><label for="listingTitle">Nama barang</label><input id="listingTitle" name="title" maxlength="90" minlength="4" placeholder="Contoh: Cardigan rajut warna sage" required></div>
        <div class="form-grid"><div class="form-field"><label for="listingPrice">Harga (Rp)</label><input id="listingPrice" name="price" type="number" min="1000" max="100000000" step="1000" placeholder="45000" required></div><div class="form-field"><label for="listingCategory">Kategori</label><select id="listingCategory" name="category" required><option value="">Pilih kategori</option><option>Atasan</option><option>Outerwear</option><option>Bawahan</option><option>Dress</option><option>Aksesori</option></select></div></div>
        <div class="form-grid"><div class="form-field"><label for="listingSize">Ukuran</label><select id="listingSize" name="size" required><option value="">Pilih ukuran</option><option>XS</option><option>S</option><option>M</option><option>L</option><option>XL</option><option>XXL</option><option>All size</option></select></div><div class="form-field"><label for="listingCondition">Kondisi barang</label><select id="listingCondition" name="condition" required><option value="">Pilih kondisi</option><option>Like new</option><option>Sangat baik</option><option>Baik</option></select></div></div>
        <div class="form-field"><label for="listingDescription">Deskripsi</label><textarea id="listingDescription" name="description" minlength="10" maxlength="1000" placeholder="Bahan, fit, detail kondisi, kekurangan kalau ada…" required></textarea><span class="form-help">Tulis dengan jujur supaya pembeli tahu kondisi barang sebelum memesan.</span></div>
        <div class="form-field"><label for="listingImage">Foto barang (opsional)</label><input id="listingImage" name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"><span class="form-help">JPG, PNG, WEBP, atau GIF · maksimal 5 MB. Kalau kosong, ilustrasi kategori akan digunakan.</span></div>
        <button class="button button-primary modal-main-button" type="submit">Terbitkan barang ↗</button>
      </form>`);
    $('#listingForm').addEventListener('submit', submitListing);
  }

  async function submitListing(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    button.disabled = true; button.textContent = 'Menerbitkan…';
    try {
      const result = await requestJson('/api/listings', {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: new FormData(form)
      });
      catalog.unshift(result.product);
      closeModal(); renderProducts(); toast('Barangmu sudah tayang di etalase! 🎉', 'success');
    } catch (error) {
      button.disabled = false; button.textContent = 'Terbitkan barang ↗';
      showInlineError(form, error.message);
    }
  }

  function openProductDetail(id) {
    const product = catalog.find((item) => item.id === id) || cart.find((item) => item.id === id);
    if (!product) return;
    const ownProduct = currentUser && product.sellerId === currentUser.id;
    openModal(`<div class="product-detail"><div class="product-detail-image"><img src="${safeImage(product.image)}" alt="Ilustrasi ${escapeHtml(product.title)}"></div><div class="product-detail-copy"><span class="detail-category">${escapeHtml(product.category)}</span><h2 class="modal-title" id="modalTitle">${escapeHtml(product.title)}</h2><p class="detail-price">${money(product.price)}</p><div class="detail-bits"><span>Ukuran ${escapeHtml(product.size)}</span><span>${escapeHtml(product.condition)}</span><span>Preloved</span></div><p class="detail-description">${escapeHtml(product.description || 'Barang preloved yang sedang mencari pemilik baru.')}</p><div class="detail-seller"><span class="detail-seller-avatar">${escapeHtml((product.sellerName || 'V').replace('@','').slice(0,1).toUpperCase())}</span><div><strong>${escapeHtml(product.sellerName || '@vestigefriend')}</strong><small>Penjual Vestige</small></div></div><button class="button button-primary modal-main-button" id="detailAddCart" ${ownProduct ? 'disabled' : ''}>${ownProduct ? 'Ini barang jualanmu' : '＋ Masukkan ke keranjang'}</button><p class="form-help" style="margin-top:10px">Checkout demo akan mencatat pesanan, belum memproses pembayaran atau pengiriman.</p></div></div>`);
    const button = $('#detailAddCart');
    if (!ownProduct) button.addEventListener('click', () => { addToCart(product); closeModal(); });
  }

  function openCart() { renderCart(); }

  function renderCart() {
    const subtotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const itemsMarkup = cart.length ? cart.map((item) => `<div class="cart-item"><img src="${safeImage(item.image)}" alt=""><div><h4>${escapeHtml(item.title)}</h4><p>${money(item.price)}</p><small class="form-help">${escapeHtml(item.category || 'Preloved')}</small></div><button type="button" class="remove-item" data-remove-cart="${item.id}" aria-label="Hapus ${escapeHtml(item.title)}">×</button></div>`).join('') : `<div class="empty-state"><span aria-hidden="true">🛍️</span><h3>Keranjang masih kosong.</h3><p>Jalan-jalan dulu di etalase, siapa tahu jatuh hati.</p><button type="button" class="button button-primary" id="cartBrowseButton">Jelajahi barang</button></div>`;
    openModal(`<div class="modal-eyebrow">YOUR GOOD FINDS</div><h2 class="modal-title" id="modalTitle">Keranjang belanja</h2><p class="modal-subtitle">Barang unik biasanya cuma satu. Kalau cocok, jangan lupa cek detailnya.</p><div class="cart-list">${itemsMarkup}</div>${cart.length ? `<div class="cart-total"><span>Subtotal (${cart.length} barang)</span><strong>${money(subtotal)}</strong></div><button class="button button-primary modal-main-button" id="checkoutButton">Lanjut ke checkout ↗</button><p class="cart-disclaimer">Ini prototipe: checkout hanya menyimpan catatan pesanan di database. Belum ada pembayaran, ongkir, atau proses pengiriman sungguhan.</p>` : ''}`);
    $$('[data-remove-cart]').forEach((button) => button.addEventListener('click', () => removeFromCart(Number(button.dataset.removeCart))));
    $('#cartBrowseButton')?.addEventListener('click', () => { closeModal(); $('#katalog').scrollIntoView({ behavior: 'smooth' }); });
    $('#checkoutButton')?.addEventListener('click', () => {
      if (!currentUser) { pendingAction = 'checkout'; openAuth('login', 'Masuk atau buat akun untuk menyimpan pesanan.'); }
      else openCheckout();
    });
  }

  function openCheckout() {
    if (!cart.length) { toast('Keranjangmu masih kosong.'); return; }
    const subtotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
    openModal(`<div class="modal-eyebrow">ALMOST YOURS ♡</div><h2 class="modal-title" id="modalTitle">Detail pesanan</h2><p class="modal-subtitle">Isi data penerima. Pesanan demo akan tercatat dan barang akan ditandai terjual.</p><div class="cart-total"><span>${cart.length} barang terpilih</span><strong>${money(subtotal)}</strong></div>
      <form id="checkoutForm" class="form-stack" novalidate><div class="form-field"><label for="buyerName">Nama penerima</label><input id="buyerName" name="buyerName" value="${escapeHtml(currentUser?.username || '')}" maxlength="100" placeholder="Nama lengkap" required></div><div class="form-field"><label for="buyerPhone">Nomor telepon</label><input id="buyerPhone" name="phone" type="tel" maxlength="20" placeholder="08xxxxxxxxxx" required></div><div class="form-field"><label for="buyerAddress">Alamat lengkap</label><textarea id="buyerAddress" name="address" minlength="10" maxlength="500" placeholder="Jalan, nomor rumah, kelurahan, kota, kode pos…" required></textarea></div><button class="button button-primary modal-main-button" type="submit">Buat pesanan demo ↗</button></form><p class="cart-disclaimer">Tidak ada uang yang ditarik. Untuk bisnis sungguhan, hubungkan payment gateway dan proses verifikasi penjual/pengiriman terlebih dahulu.</p>`);
    $('#checkoutForm').addEventListener('submit', submitCheckout);
  }

  async function submitCheckout(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = $('button[type="submit"]', form);
    button.disabled = true; button.textContent = 'Menyimpan pesanan…';
    try {
      const result = await requestJson('/api/orders', {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ buyerName: data.get('buyerName'), phone: data.get('phone'), address: data.get('address'), productIds: cart.map((item) => item.id) })
      });
      cart = []; saveStorage('vestige-cart', cart); updateHeader(); await loadCatalog();
      openModal(`<div class="quiz-result"><div class="quiz-result-emoji">🎉</div><div class="modal-eyebrow">ORDER SAVED</div><h3 id="modalTitle">Pesanan tercatat!</h3><p>Nomor pesanan <strong>#VST-${result.order.id}</strong> tersimpan di database dengan status <strong>${escapeHtml(result.order.status)}</strong>. Ini masih demo, jadi tidak ada pembayaran atau pengiriman sungguhan.</p><div class="cart-total"><span>Total pesanan</span><strong>${money(result.order.total)}</strong></div><button type="button" class="button button-primary modal-main-button" id="doneOrderButton">Kembali belanja ↗</button></div>`);
      $('#doneOrderButton').addEventListener('click', () => { closeModal(); $('#katalog').scrollIntoView({ behavior: 'smooth' }); });
    } catch (error) {
      button.disabled = false; button.textContent = 'Buat pesanan demo ↗'; showInlineError(form, error.message);
    }
  }

  async function openAccount() {
    if (!currentUser) { openAuth('login'); return; }
    let listings = [], orders = [], sales = [];
    try {
      const [myListings, myOrders, mySales] = await Promise.all([requestJson('/api/my-listings'), requestJson('/api/my-orders'), requestJson('/api/my-sales')]);
      listings = myListings.products || []; orders = myOrders.orders || []; sales = mySales.sales || [];
    } catch (error) {
      if (error.status === 401) { currentUser = null; updateHeader(); openAuth('login'); return; }
      toast(error.message, 'error');
    }
    const listingsMarkup = listings.length ? listings.map((item) => `<div class="account-list-item"><div><strong>${escapeHtml(item.title)}</strong><small>${money(item.price)} · ukuran ${escapeHtml(item.size)}</small></div><span class="status-tag ${item.status === 'sold' ? 'sold' : ''}">${item.status === 'sold' ? 'Terjual' : 'Tayang'}</span></div>`).join('') : `<p class="form-help">Belum ada barang yang kamu pasang. Punya baju yang jarang dipakai? Kasih kesempatan kedua.</p>`;
    const ordersMarkup = orders.length ? orders.map((order) => `<div class="account-list-item"><div><strong>Pesanan #VST-${order.id}</strong><small>${escapeHtml(order.items.map((item) => item.title).join(', '))} · ${money(order.total)}</small></div><span class="status-tag">${escapeHtml(order.status)}</span></div>`).join('') : `<p class="form-help">Belum ada pesanan tersimpan.</p>`;
    const salesMarkup = sales.length ? sales.map((sale) => `<div class="account-list-item"><div><strong>Pesanan #VST-${sale.id} · ${escapeHtml(sale.buyerName)}</strong><small>${escapeHtml(sale.items.map((item) => item.title).join(', '))} · ${money(sale.items.reduce((sum, item) => sum + item.price, 0))}<br>${escapeHtml(sale.phone)} · ${escapeHtml(sale.address)}</small></div><span class="status-tag">${escapeHtml(sale.status)}</span></div>`).join('') : `<p class="form-help">Belum ada pesanan masuk untuk barang yang kamu pasang.</p>`;
    const roleText = { buyer: 'Pembeli', seller: 'Penjual', both: 'Pembeli + penjual' }[currentUser.role] || 'Anggota';
    openModal(`<div class="modal-eyebrow">YOUR LITTLE CORNER</div><div class="account-header"><div class="account-avatar">${escapeHtml(currentUser.username.slice(0,1).toUpperCase())}</div><div><h3 id="modalTitle">Hai, ${escapeHtml(currentUser.username)}!</h3><p>${escapeHtml(currentUser.email)} · ${roleText}</p></div></div><button class="button button-primary" id="accountSellButton">＋ Pasang barang baru</button><div class="account-section"><h4>Barang yang kamu jual <span>${listings.length}</span></h4><div class="account-list">${listingsMarkup}</div></div><div class="account-section"><h4>Pesanan kamu <span>${orders.length}</span></h4><div class="account-list">${ordersMarkup}</div></div><div class="account-section"><h4>Pesanan masuk dari pembeli <span>${sales.length}</span></h4><div class="account-list">${salesMarkup}</div></div><div class="account-section"><button class="button button-outline" id="logoutButton">Keluar dari akun</button><p class="form-help" style="margin-top:10px">Data akun, barang dan pesanan tersimpan di SQLite di perangkat/server yang menjalankan demo ini.</p></div>`);
    $('#accountSellButton').addEventListener('click', openSellModal);
    $('#logoutButton').addEventListener('click', async () => {
      const button = $('#logoutButton'); button.disabled = true; button.textContent = 'Keluar…';
      try {
        await requestJson('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: '{}' });
        currentUser = null; csrfToken = ''; updateHeader(); closeModal(); toast('Kamu sudah keluar dari akun.');
      } catch (error) { button.disabled = false; button.textContent = 'Keluar dari akun'; toast(error.message, 'error'); }
    });
  }

  const quizQuestions = [
    {
      title: 'Warna dan vibe mana yang paling kamu suka?',
      subtitle: 'Pilih yang paling bikin kamu merasa jadi diri sendiri.',
      options: [
        { value: 'earthy', emoji: '🌿', title: 'Earthy & warm', desc: 'Cokelat, olive, cream' },
        { value: 'soft', emoji: '☁️', title: 'Soft & sweet', desc: 'Pastel dan warna lembut' },
        { value: 'bold', emoji: '🍒', title: 'Bold & playful', desc: 'Warna seru, detail unik' },
        { value: 'neutral', emoji: '🖤', title: 'Clean & neutral', desc: 'Simpel dan versatile' },
      ]
    },
    {
      title: 'Kalau memilih outfit, kamu lebih suka…',
      subtitle: 'Nggak ada jawaban benar atau salah!',
      options: [
        { value: 'casual', emoji: '👟', title: 'Santai tiap hari', desc: 'Nyaman, gampang dipadu' },
        { value: 'vintage', emoji: '📻', title: 'Sentuhan vintage', desc: 'Retro dengan karakter' },
        { value: 'statement', emoji: '✨', title: 'Jadi pusat perhatian', desc: 'Statement piece yang seru' },
        { value: 'minimal', emoji: '🤍', title: 'Rapi minimalis', desc: 'Potongan clean dan timeless' },
      ]
    },
    {
      title: 'Barang apa yang paling kamu cari?',
      subtitle: 'Kami bakal pakai pilihan ini untuk menyaring rekomendasi.',
      options: [
        { value: 'Atasan', emoji: '👕', title: 'Atasan', desc: 'Tee, kemeja, blouse' },
        { value: 'Outerwear', emoji: '🧥', title: 'Outerwear', desc: 'Jaket, cardigan, vest' },
        { value: 'Bawahan', emoji: '👖', title: 'Bawahan', desc: 'Jeans, rok, celana' },
        { value: 'Dress', emoji: '👗', title: 'Dress', desc: 'One-piece yang praktis' },
      ]
    }
  ];

  function startQuiz() {
    quizIndex = 0; quizAnswers = []; quizCategory = 'Atasan'; renderQuizStep();
  }

  function renderQuizStep() {
    if (quizIndex >= quizQuestions.length) { renderQuizResult(); return; }
    const question = quizQuestions[quizIndex];
    const selected = quizAnswers[quizIndex];
    const progress = ((quizIndex + 1) / quizQuestions.length) * 100;
    openModal(`<div class="modal-eyebrow">YOUR STYLE, YOUR RULES · ${quizIndex + 1}/3</div><h2 class="quiz-question" id="modalTitle">${question.title}</h2><p class="modal-subtitle">${question.subtitle}</p><div class="quiz-progress"><span style="width:${progress}%"></span></div><div class="quiz-option-grid">${question.options.map((option) => `<button type="button" class="quiz-option ${selected === option.value ? 'selected' : ''}" data-quiz-value="${escapeHtml(option.value)}"><span class="option-emoji">${option.emoji}</span><strong>${escapeHtml(option.title)}</strong><small>${escapeHtml(option.desc)}</small></button>`).join('')}</div><div class="quiz-controls"><button type="button" class="button button-outline" id="quizBackButton" ${quizIndex === 0 ? 'disabled' : ''}>← Kembali</button><button type="button" class="button button-primary" id="quizNextButton" ${selected ? '' : 'disabled'}>${quizIndex === quizQuestions.length - 1 ? 'Lihat hasil ✳' : 'Lanjut →'}</button></div>`);
    $$('[data-quiz-value]').forEach((button) => button.addEventListener('click', () => {
      quizAnswers[quizIndex] = button.dataset.quizValue;
      $$('[data-quiz-value]').forEach((option) => option.classList.toggle('selected', option === button));
      $('#quizNextButton').disabled = false;
    }));
    $('#quizBackButton').addEventListener('click', () => { if (quizIndex > 0) quizIndex -= 1; renderQuizStep(); });
    $('#quizNextButton').addEventListener('click', () => {
      if (!quizAnswers[quizIndex]) return;
      if (quizIndex === quizQuestions.length - 1) { quizCategory = quizAnswers[2]; renderQuizResult(); }
      else { quizIndex += 1; renderQuizStep(); }
    });
  }

  function renderQuizResult() {
    const vibe = quizAnswers[1] || 'casual';
    const resultMap = {
      casual: { name: 'The Comfy Explorer', emoji: '🌤️', copy: 'Kamu suka pieces yang nyaman, gampang dipakai ulang, dan fleksibel buat banyak suasana.' },
      vintage: { name: 'The Vintage Collector', emoji: '📻', copy: 'Kamu punya mata untuk detail unik dan potongan yang punya cerita. Berburu temuan retro bisa jadi seru!' },
      statement: { name: 'The Playful One', emoji: '🍒', copy: 'Kamu suka fashion yang terasa personal. Cari satu item unik lalu biarkan itu jadi bintang outfit.' },
      minimal: { name: 'The Timeless Curator', emoji: '🤍', copy: 'Kamu suka barang versatile yang bisa dipadukan berkali-kali. Pilih kualitas dan kondisi yang paling cocok.' },
    };
    const result = resultMap[vibe] || resultMap.casual;
    const palette = quizAnswers[0] || 'soft';
    const paletteText = { earthy: 'earthy', soft: 'soft pastel', bold: 'bold & playful', neutral: 'clean neutral' }[palette];
    openModal(`<div class="quiz-result"><div class="quiz-result-emoji">${result.emoji}</div><div class="modal-eyebrow">YOUR STYLE CARD</div><h3 id="modalTitle">${result.name}</h3><p>${result.copy} Karena kamu memilih palet <strong>${paletteText}</strong>, kami pilihkan kategori <strong>${escapeHtml(quizCategory)}</strong> buat dijelajahi.</p><button class="button button-primary modal-main-button" id="quizShopButton">Jelajahi ${escapeHtml(quizCategory)} ↗</button><button class="button button-outline modal-main-button" id="quizAgainButton" style="margin-top:9px">Ulangi kuis</button></div>`);
    $('#quizShopButton').addEventListener('click', () => {
      activeCategory = quizCategory; searchTerm = ''; sizeFilter = ''; sortFilter = 'newest'; showAllProducts = false;
      $('#searchInput').value = ''; $('#sizeFilter').value = ''; $('#sortFilter').value = 'newest';
      $$('.category-pill').forEach((pill) => pill.classList.toggle('active', pill.dataset.category === activeCategory));
      closeModal(); renderProducts(); $('#katalog').scrollIntoView({ behavior: 'smooth' });
    });
    $('#quizAgainButton').addEventListener('click', startQuiz);
  }

  function toggleAudio() {
    if (isSpeaking) { stopAudio(); return; }
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      $('#audioNote').textContent = 'Browser ini belum mendukung audio otomatis. Coba browser versi terbaru.';
      toast('Fitur audio tidak tersedia di browser ini.', 'error'); return;
    }
    const message = 'Selamat datang di Vestige. Setiap pakaian punya cerita, dan ceritanya tidak harus berhenti saat pemilik pertama selesai memakainya. Dengan memilih barang preloved, kita memberi pakaian kesempatan kedua, menemukan gaya yang unik, dan memakai barang yang sudah ada lebih lama. Mulai dari satu pilihan kecil. Pakai lagi, sayangi lagi.';
    window.speechSynthesis.cancel();
    speechUtterance = new SpeechSynthesisUtterance(message);
    speechUtterance.lang = 'id-ID'; speechUtterance.rate = 0.94; speechUtterance.pitch = 1;
    speechUtterance.onstart = () => {
      isSpeaking = true; $('#audioButtonTitle').textContent = 'Sedang bercerita…'; $('#audioPlayIcon').textContent = 'Ⅱ'; $('#audioNote').textContent = 'Audio sedang diputar. Tekan untuk berhenti.';
    };
    speechUtterance.onend = () => resetAudioUI();
    speechUtterance.onerror = () => { resetAudioUI(); $('#audioNote').textContent = 'Audio tidak bisa diputar saat ini. Coba lagi.'; };
    window.speechSynthesis.speak(speechUtterance);
  }

  function stopAudio() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    resetAudioUI();
  }

  function resetAudioUI() {
    isSpeaking = false; speechUtterance = null;
    $('#audioButtonTitle').textContent = 'Dengarkan cerita kami'; $('#audioPlayIcon').textContent = '▶';
    $('#audioNote').textContent = 'Audio menggunakan fitur suara di browser kamu.';
  }

  function initRevealAnimations() {
    const revealItems = $$('.reveal');
    if (!('IntersectionObserver' in window)) { revealItems.forEach((item) => item.classList.add('is-visible')); return; }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
      });
    }, { threshold: 0.12 });
    revealItems.forEach((item) => observer.observe(item));
  }

  init();
})();
