/* Christmas Larder: a shared list of Christmas food in the garage freezers and boxes.
 * The list is saved in a Google Sheet through a small script (see google-sheet/Code.gs).
 * Product names come from Open Food Facts the first time a barcode is scanned. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const daysUntil = iso => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(y, m - 1, d) - t) / 86400000); };
  const fmtDate = iso => { if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return ""; const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 18);
  const cleanCode = s => String(s || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 40);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };

  const state = {
    url: store.get("larder.sheetUrl") || "",
    items: [], places: [], products: new Map(),
    filter: store.get("larder.filter") || "all", q: "",
    loaded: false, pending: 0, lastSync: null, syncError: "",
  };

  // ---------- setup link: ?sheet=<web app url> ----------
  (() => {
    const params = new URLSearchParams(location.search);
    const s = params.get("sheet");
    if (s && /^https:\/\/script\.google(usercontent)?\.com\//.test(s)) { state.url = s; store.set("larder.sheetUrl", s); }
    if (s) history.replaceState(null, "", location.pathname);
  })();

  // ---------- talking to the Google Sheet ----------
  async function call(body) {
    if (!state.url) throw new Error("not set up");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = body
        ? await fetch(state.url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: ctrl.signal })
        : await fetch(state.url + (state.url.includes("?") ? "&" : "?") + "action=list", { signal: ctrl.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error("The sheet link isn't answering like the larder script. Check the link in Settings."); }
      if (!json.ok) throw new Error(json.error || "The sheet said no.");
      return json.data;
    } finally { clearTimeout(timer); }
  }
  function applySnapshot(data) {
    if (!data || !Array.isArray(data.items)) return;
    state.items = data.items.map(i => ({ ...i, qty: Number(i.qty) || 0 }));
    state.places = (data.places || []).map(p => ({ ...p, order: Number(p.order) || 0 })).sort((a, b) => a.order - b.order);
    state.products = new Map((data.products || []).map(p => [String(p.barcode), p]));
    state.loaded = true; state.lastSync = new Date(); state.syncError = "";
    store.set("larder.cache", JSON.stringify({ url: state.url, items: data.items, places: data.places, products: data.products }));
    render();
  }
  let refreshing = false;
  async function refresh() {
    if (!state.url || refreshing || state.pending) return;
    refreshing = true;
    try { const data = await call(null); if (!state.pending) applySnapshot(data); }
    catch (e) { state.syncError = navigator.onLine === false ? "You're offline. Changes can't be saved until you're back online." : e.message; renderSync(); }
    finally { refreshing = false; }
  }
  // Writes go one at a time, in order. The last reply refreshes the list.
  let chain = Promise.resolve();
  function write(body, failMsg) {
    state.pending++; renderSync();
    chain = chain.then(async () => {
      try {
        const data = await call(body);
        state.pending--;
        if (!state.pending) applySnapshot(data);
      } catch (e) {
        state.pending--;
        state.syncError = e.message; renderSync();
        toast(failMsg || "That didn't save. Check your connection and try again.");
        if (!state.pending) refresh();
      }
    });
    return chain;
  }

  // ---------- Open Food Facts ----------
  async function lookupProduct(code) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,generic_name,brands,quantity`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const j = await res.json();
      if (j.status !== 1 || !j.product) return null;
      const p = j.product;
      const base = (p.product_name_en || p.product_name || p.generic_name || "").trim();
      const brand = (p.brands || "").split(",")[0].trim();
      if (!base && !brand) return null;
      const name = base && brand && !base.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${base}` : (base || brand);
      return { name: name.slice(0, 80), unit: (p.quantity || "").trim().slice(0, 30), brand };
    } catch (e) { return null; }
    finally { clearTimeout(timer); }
  }

  // ---------- rendering ----------
  const placeName = id => (state.places.find(p => p.id === id) || {}).name || "No place set";
  function useByTag(it) {
    if (!it.useBy || !fmtDate(it.useBy)) return "";
    const n = daysUntil(it.useBy);
    if (n < 0) return `<span class="tag gone">Past use-by ${esc(fmtDate(it.useBy))}</span>`;
    if (n <= 14) return `<span class="tag soon">Use by ${esc(fmtDate(it.useBy))}</span>`;
    return `<span>Use by ${esc(fmtDate(it.useBy))}</span>`;
  }
  function renderSync() {
    const el = $("#sync");
    if (!state.url) { el.textContent = ""; return; }
    if (state.pending) { el.className = "sync"; el.textContent = "Saving…"; return; }
    if (state.syncError) { el.className = "sync bad"; el.textContent = state.syncError; return; }
    el.className = "sync";
    el.textContent = state.lastSync ? `Up to date · ${state.lastSync.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Loading…";
  }
  function renderChips() {
    const soon = state.items.filter(i => i.useBy && fmtDate(i.useBy) && daysUntil(i.useBy) <= 14).length;
    const chips = [`<button class="chip" data-f="all" aria-pressed="${state.filter === "all"}">Everything</button>`];
    for (const p of state.places) chips.push(`<button class="chip" data-f="${esc(p.id)}" aria-pressed="${state.filter === p.id}">${esc(p.name)}</button>`);
    if (soon) chips.push(`<button class="chip warn" data-f="soon" aria-pressed="${state.filter === "soon"}">Use soon (${soon})</button>`);
    chips.push(`<button class="chip ghost" data-act="places">Edit places</button>`);
    $("#chips").innerHTML = chips.join("");
  }
  function render() {
    renderSync();
    const main = $("#main");
    $("#dock").hidden = !state.url || !state.loaded;
    if (!state.url) {
      $("#chips").innerHTML = ""; $("#count").textContent = "";
      main.innerHTML = `<div class="empty"><strong>Connect your Google Sheet</strong><span>The larder list is kept in a Google Sheet so the whole household shares it.</span><button class="btn primary" data-act="settings">Set up</button></div>`;
      return;
    }
    if (!state.loaded) return;
    if (state.filter !== "all" && state.filter !== "soon" && !state.places.some(p => p.id === state.filter)) state.filter = "all";
    renderChips();
    const total = state.items.reduce((a, i) => a + i.qty, 0);
    $("#count").textContent = `${state.items.length} item${state.items.length === 1 ? "" : "s"} · ${total} in stock`;

    if (!state.places.length && !state.items.length) {
      main.innerHTML = `<div class="empty"><strong>No places set up yet</strong><span>Add your freezers and boxes first, then add what's in them.</span><button class="btn primary" data-act="places">Set up places</button></div>`;
      return;
    }
    const q = state.q.trim().toLowerCase();
    let items = state.items.filter(i => !q || (i.name || "").toLowerCase().includes(q) || (i.barcode || "").includes(q));
    if (state.filter === "soon") items = items.filter(i => i.useBy && fmtDate(i.useBy) && daysUntil(i.useBy) <= 14).sort((a, b) => a.useBy.localeCompare(b.useBy));
    else if (state.filter !== "all") items = items.filter(i => i.placeId === state.filter);
    if (!items.length) {
      main.innerHTML = `<div class="empty"><strong>${q ? "Nothing matches that search" : state.items.length ? "Nothing here yet" : "The larder is empty"}</strong><span>Tap “Scan” or “Add item” to put something in.</span></div>`;
      return;
    }
    const groups = new Map([...state.places.map(p => [p.id, []]), ["__none", []]]);
    for (const it of items) groups.get(groups.has(it.placeId) && it.placeId !== "__none" ? it.placeId : "__none").push(it);
    const html = [];
    for (const [k, list] of groups) {
      if (!list.length) continue;
      if (state.filter !== "soon") list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      html.push(`<section class="group"><h2><span>${esc(k === "__none" ? "No place set" : placeName(k))}</span><span>${list.length}</span></h2><ul class="list">${list.map(rowHTML).join("")}</ul></section>`);
    }
    main.innerHTML = html.join("");
  }
  function rowHTML(it) {
    const meta = [];
    if (state.filter === "soon") meta.push(`<span>${esc(placeName(it.placeId))}</span>`);
    if (fmtDate(it.added)) meta.push(`<span>Added ${esc(fmtDate(it.added))}</span>`);
    const ub = useByTag(it); if (ub) meta.push(ub);
    const id = esc(it.id), nm = esc(it.name);
    const right = it.qty <= 0
      ? `<div class="zero"><button class="btn small danger" data-act="del" data-id="${id}">Remove</button><button class="step" data-act="inc" data-id="${id}" aria-label="Add one ${nm}">+</button></div>`
      : `<div class="qty"><button class="step" data-act="dec" data-id="${id}" aria-label="Take one ${nm}">−</button><output>${it.qty}</output><button class="step" data-act="inc" data-id="${id}" aria-label="Add one ${nm}">+</button></div>`;
    return `<li class="row"><button class="info" data-act="edit" data-id="${id}"><div class="name">${nm}${it.unit ? ` <span class="hint">(${esc(it.unit)})</span>` : ""}</div><div class="meta">${meta.join("")}</div></button>${right}</li>`;
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, undo) {
    clearTimeout(toastTimer);
    $("#toastHost").innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${undo ? `<button id="undoBtn">Undo</button>` : ""}</div>`;
    if (undo) $("#undoBtn").onclick = () => { $("#toastHost").innerHTML = ""; undo(); };
    toastTimer = setTimeout(() => { $("#toastHost").innerHTML = ""; }, undo ? 6000 : 2800);
  }

  // ---------- changes ----------
  function changeQty(id, delta) {
    const it = state.items.find(i => i.id === id); if (!it) return;
    it.qty = Math.max(0, it.qty + delta); render();
    write({ action: "adjust", id, delta });
  }
  function deleteItem(id) {
    const it = state.items.find(i => i.id === id); if (!it) return;
    state.items = state.items.filter(i => i.id !== id); render();
    write({ action: "deleteItem", id });
    const copy = { ...it, qty: String(it.qty) };
    toast(`Removed ${it.name}`, () => { state.items.push(it); render(); write({ action: "saveItem", item: copy }); });
  }
  function saveItem(item) {
    const i = state.items.findIndex(x => x.id === item.id);
    if (i === -1) state.items.push({ ...item }); else state.items[i] = { ...item };
    render();
    write({ action: "saveItem", item: { ...item, qty: String(item.qty) } });
  }
  function rememberProduct(code, name, unit, source, brand) {
    if (!code || !name) return;
    const known = state.products.get(code);
    if (known && known.name === name && (known.unit || "") === (unit || "")) return;
    state.products.set(code, { barcode: code, name, unit });
    write({ action: "saveProduct", product: { barcode: code, name, unit: unit || "", brand: brand || "", source: source || "typed", updatedAt: new Date().toISOString() } });
  }

  // ---------- sheets ----------
  function closeSheet() { $("#sheetHost").innerHTML = ""; }
  function openSheet(html, onMount) {
    $("#sheetHost").innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
    $("#scrim").addEventListener("click", e => { if (e.target.id === "scrim") closeSheet(); });
    const sheet = $("#sheetHost .sheet");
    onMount && onMount(sheet);
    return sheet;
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if ($("#cameraHost").innerHTML) closeCamera(); else closeSheet(); } });
  const lastPlace = () => { const l = store.get("larder.lastPlace"); return state.places.some(p => p.id === l) ? l : null; };

  function itemSheet(id, preset, note, lookupCode) {
    const it = id ? state.items.find(i => i.id === id) : null;
    const p = it || preset || {};
    if (!state.places.length) { placesSheet("Add a freezer or box first, so items have somewhere to go."); return; }
    const defPlace = (p.placeId && state.places.some(x => x.id === p.placeId)) ? p.placeId
      : state.places.some(x => x.id === state.filter) ? state.filter : (lastPlace() || state.places[0].id);
    const opts = state.places.map(x => `<option value="${esc(x.id)}" ${x.id === defPlace ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    openSheet(`
      <h3>${it ? "Edit item" : "Add item"}</h3>
      <div class="note" id="f-note" ${note ? "" : "hidden"}>${note || ""}</div>
      <form id="itemForm" style="display:grid;gap:14px" novalidate>
        <label class="field">What is it?<input id="f-name" name="name" required maxlength="80" placeholder="e.g. Mince pies" value="${esc(p.name)}" list="known-names" autocomplete="off"></label>
        <datalist id="known-names">${[...new Set(state.items.map(i => i.name))].map(n => `<option value="${esc(n)}">`).join("")}</datalist>
        <div class="pair">
          <label class="field">How many?<input id="f-qty" name="qty" type="number" inputmode="numeric" min="0" step="1" value="${esc(it ? it.qty : 1)}"></label>
          <label class="field">Pack size<input id="f-unit" name="unit" maxlength="30" placeholder="optional" value="${esc(p.unit)}"></label>
        </div>
        <label class="field">Where is it?<select id="f-place" name="placeId">${opts}</select></label>
        <div class="pair">
          <label class="field">Date added<input id="f-added" name="added" type="date" value="${esc(it?.added || todayISO())}"></label>
          <label class="field">Use by (if any)<input id="f-useby" name="useBy" type="date" value="${esc(it?.useBy)}"></label>
        </div>
        <label class="field">Barcode <span class="hint">filled in when you scan</span><input id="f-barcode" name="barcode" inputmode="numeric" maxlength="40" value="${esc(p.barcode)}"></label>
        <div class="err" id="f-err" hidden></div>
        <div class="actions">
          ${it ? `<button type="button" class="btn danger" id="f-del">Remove</button>` : ""}
          <button type="button" class="btn" id="f-cancel">Cancel</button>
          <button type="submit" class="btn primary grow">${it ? "Save" : "Add to larder"}</button>
        </div>
      </form>`, sheet => {
      const form = $("#itemForm", sheet);
      let source = preset && preset.source || "typed", brand = preset && preset.brand || "";
      if (!it && !p.name && !lookupCode) setTimeout(() => $("#f-name", sheet).focus(), 60);
      $("#f-cancel", sheet).onclick = closeSheet;
      if (it) $("#f-del", sheet).onclick = () => { closeSheet(); deleteItem(it.id); };
      if (lookupCode) {
        const nameEl = $("#f-name", sheet), noteEl = $("#f-note", sheet);
        nameEl.placeholder = "Looking it up…";
        lookupProduct(lookupCode).then(found => {
          if (!sheet.isConnected) return;
          nameEl.placeholder = "e.g. Mince pies";
          if (found) {
            if (!nameEl.value.trim()) nameEl.value = found.name;
            if (!$("#f-unit", sheet).value.trim() && found.unit) $("#f-unit", sheet).value = found.unit;
            source = "openfoodfacts"; brand = found.brand;
            noteEl.innerHTML = `Found <strong>${esc(found.name)}</strong> on Open Food Facts. Change the name if you like, then add it.`;
          } else {
            noteEl.innerHTML = `New barcode <span class="code">${esc(lookupCode)}</span> isn't in Open Food Facts. Type what it is once and the app will remember it.`;
            nameEl.focus();
          }
          noteEl.hidden = false;
        });
      }
      form.addEventListener("submit", e => {
        e.preventDefault();
        const fd = new FormData(form);
        const name = String(fd.get("name") || "").trim();
        if (!name) { const er = $("#f-err", sheet); er.textContent = "Give the item a name."; er.hidden = false; return; }
        const now = new Date().toISOString();
        const item = {
          id: it ? it.id : newId(),
          name,
          qty: Math.max(0, parseInt(fd.get("qty"), 10) || 0),
          unit: String(fd.get("unit") || "").trim(),
          placeId: String(fd.get("placeId")),
          added: String(fd.get("added") || todayISO()),
          useBy: String(fd.get("useBy") || ""),
          barcode: cleanCode(fd.get("barcode")),
          createdAt: it ? (it.createdAt || now) : now,
          updatedAt: now,
        };
        store.set("larder.lastPlace", item.placeId);
        closeSheet();
        saveItem(item);
        toast(it ? `Saved ${name}` : `Added ${item.qty} × ${name} to ${placeName(item.placeId)}`);
        const known = state.products.get(item.barcode);
        rememberProduct(item.barcode, item.name, item.unit, known && known.name === item.name ? known.source : source, brand);
      });
    });
  }

  function placesSheet(message) {
    const rows = () => state.places.map(p => {
      const n = state.items.filter(i => i.placeId === p.id).length;
      return `<div class="loc-row"><input data-place="${esc(p.id)}" value="${esc(p.name)}" maxlength="40" aria-label="Name of place"><span class="hint">${n} item${n === 1 ? "" : "s"}</span><button class="btn small danger" data-placedel="${esc(p.id)}" ${n ? "disabled title=\"Move or remove its items first\"" : ""}>Delete</button></div>`;
    }).join("");
    openSheet(`
      <h3>Freezers and boxes</h3>
      ${message ? `<div class="note">${esc(message)}</div>` : ""}
      <p class="hint">Rename a place by typing over its name. A place can be deleted once it's empty.</p>
      <div id="placeList" style="display:grid;gap:8px">${rows()}</div>
      <form id="placeForm" class="actions" novalidate>
        <input class="search" id="newPlace" placeholder="New place, e.g. Garage freezer 3" maxlength="40" style="flex:1;min-width:0">
        <button class="btn primary" type="submit">Add</button>
      </form>
      <div class="actions"><button class="btn grow" id="placeDone">Done</button></div>`, sheet => {
      $("#placeDone", sheet).onclick = closeSheet;
      $("#placeForm", sheet).addEventListener("submit", e => {
        e.preventDefault();
        const inp = $("#newPlace", sheet); const name = inp.value.trim(); if (!name) return;
        const order = state.places.reduce((m, p) => Math.max(m, p.order), 0) + 1;
        const place = { id: newId(), name, order };
        state.places.push(place); inp.value = "";
        $("#placeList", sheet).innerHTML = rows(); render();
        write({ action: "savePlace", place: { ...place, order: String(order) } });
      });
      sheet.addEventListener("change", e => {
        const id = e.target.dataset && e.target.dataset.place; if (!id) return;
        const name = e.target.value.trim(); const p = state.places.find(x => x.id === id);
        if (!name || !p || name === p.name) { if (p) e.target.value = p.name; return; }
        p.name = name; render();
        write({ action: "savePlace", place: { id, name } });
        toast(`Renamed to ${name}`);
      });
      sheet.addEventListener("click", e => {
        const id = e.target.dataset && e.target.dataset.placedel; if (!id) return;
        if (state.items.some(i => i.placeId === id)) return;
        state.places = state.places.filter(p => p.id !== id);
        $("#placeList", sheet).innerHTML = rows(); render();
        write({ action: "deletePlace", id });
      });
    });
  }

  function settingsSheet() {
    const shareLink = () => `${location.origin}${location.pathname}?sheet=${encodeURIComponent(state.url)}`;
    openSheet(`
      <h3>Settings</h3>
      <p class="hint">The list is saved in your Google Sheet. Paste the web app link from the sheet's script here. <a href="https://github.com/localpulse26-debug/Christmas-Larder-#set-up" target="_blank" rel="noopener">How to get the link</a></p>
      <form id="setForm" style="display:grid;gap:12px" novalidate>
        <label class="field">Sheet link<input id="s-url" type="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.url)}"></label>
        <div id="s-msg" aria-live="polite"></div>
        <div class="actions"><button type="button" class="btn" id="s-close">Close</button><button class="btn primary grow" type="submit">Save and test</button></div>
      </form>
      <div id="s-share" ${state.url ? "" : "hidden"} style="display:grid;gap:8px">
        <p class="hint">Send this link to the family. Opening it sets up their phone in one tap. Keep it private, as anyone with it can change the list.</p>
        <button class="btn" id="s-sharebtn">Share setup link</button>
      </div>`, sheet => {
      $("#s-close", sheet).onclick = closeSheet;
      $("#s-sharebtn", sheet).onclick = async () => {
        const url = shareLink();
        try { if (navigator.share) { await navigator.share({ title: "Christmas Larder", text: "Our Christmas food list", url }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
        try { await navigator.clipboard.writeText(url); toast("Setup link copied"); } catch (e) { $("#s-msg", sheet).innerHTML = `<p class="hint" style="overflow-wrap:anywhere">${esc(url)}</p>`; }
      };
      $("#setForm", sheet).addEventListener("submit", async e => {
        e.preventDefault();
        const url = $("#s-url", sheet).value.trim();
        const msg = $("#s-msg", sheet);
        if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { msg.innerHTML = `<p class="err">That doesn't look like a sheet script link. It starts with https://script.google.com/macros/s/ and ends with /exec.</p>`; return; }
        msg.innerHTML = `<p class="hint">Testing…</p>`;
        const old = state.url; state.url = url;
        try {
          const data = await call(null);
          store.set("larder.sheetUrl", url);
          applySnapshot(data);
          msg.innerHTML = `<p class="ok">Connected. ${data.places.length} places and ${data.items.length} items found.</p>`;
          $("#s-share", sheet).hidden = false;
        } catch (err) {
          state.url = old;
          msg.innerHTML = `<p class="err">Couldn't reach the sheet. ${esc(err.message)} Check that the script is deployed with access set to “Anyone”.</p>`;
        }
      });
    });
  }

  // ---------- scanning ----------
  const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"];
  let cam = null; // { stream, timer }
  function zxHints() {
    const ZX = window.ZXing; const hints = new Map();
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.ITF]);
    return hints;
  }
  async function nativeDetector() {
    if (!("BarcodeDetector" in window)) return null;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter(f => supported.includes(f));
      return formats.length ? new window.BarcodeDetector({ formats }) : null;
    } catch (e) { return null; }
  }
  function closeCamera() {
    if (cam) {
      clearTimeout(cam.timer);
      try { cam.stream && cam.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      cam = null;
    }
    $("#cameraHost").innerHTML = "";
  }
  async function openCamera() {
    closeSheet();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("#photoFile").value = ""; $("#photoFile").click(); return; }
    $("#cameraHost").innerHTML = `
      <div class="camera" role="dialog" aria-label="Scan a barcode">
        <div style="position:relative;overflow:hidden">
          <video id="camVideo" playsinline muted></video>
          <div class="frame"></div>
          <div class="cam-msg" id="camMsg">Starting the camera…</div>
        </div>
        <div class="cam-bar">
          <label class="btn" for="photoFile" role="button" tabindex="0">Use a photo</label>
          <button class="btn" id="camType">Type numbers</button>
          <button class="btn" id="camClose">Close</button>
        </div>
      </div>`;
    $("#camClose").onclick = closeCamera;
    $("#camType").onclick = () => { closeCamera(); manualSheet(); };
    const video = $("#camVideo"), msg = $("#camMsg");
    const session = cam = {};
    const done = code => { if (cam !== session) return; try { navigator.vibrate && navigator.vibrate(60); } catch (e) {} closeCamera(); handleCode(cleanCode(code)); };
    try {
      const detector = await nativeDetector();
      if (!detector && !window.ZXing) throw new Error("scanner not loaded");
      session.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (cam !== session) { session.stream.getTracks().forEach(t => t.stop()); return; }
      video.srcObject = session.stream;
      try { await video.play(); } catch (e) {}
      msg.textContent = "Point the camera at a barcode";
      let reader = null, canvas = null;
      if (!detector) { reader = new window.ZXing.MultiFormatReader(); reader.setHints(zxHints()); canvas = document.createElement("canvas"); }
      const tick = async () => {
        if (cam !== session) return;
        if (video.readyState >= 2 && video.videoWidth) {
          if (detector) {
            try { const r = await detector.detect(video); if (r && r[0] && r[0].rawValue) return done(r[0].rawValue); } catch (e) {}
          } else {
            // Read the middle band of the picture, where the frame on screen is.
            const vw = video.videoWidth, vh = video.videoHeight;
            const k = Math.min(1, 960 / vw);
            const sy = Math.round(vh * 0.2), sh = Math.round(vh * 0.6);
            canvas.width = Math.round(vw * k); canvas.height = Math.round(sh * k);
            const g = canvas.getContext("2d", { willReadFrequently: true });
            g.drawImage(video, 0, sy, vw, sh, 0, 0, canvas.width, canvas.height);
            try {
              const ZX = window.ZXing;
              const r = reader.decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(canvas))));
              if (r && r.getText()) return done(r.getText());
            } catch (e) { /* nothing found in this frame */ }
          }
        }
        session.timer = setTimeout(tick, detector ? 150 : 250);
      };
      tick();
    } catch (e) {
      console.warn(e);
      if (cam !== session) return;
      msg.textContent = e && (e.name === "NotAllowedError" || e.name === "SecurityError")
        ? "The camera is blocked. Allow camera access for this site in your browser settings, or use a photo."
        : "The camera didn't start. Use a photo or type the numbers instead.";
    }
  }

  // Photo fallback
  function imgFrom(src) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error("The photo could not be opened.")); img.src = src; }); }
  function drawScaled(img, max, rotate) {
    const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
    const sw = Math.round(w * k), sh = Math.round(h * k);
    const c = document.createElement("canvas");
    if (rotate) { c.width = sh; c.height = sw; } else { c.width = sw; c.height = sh; }
    const g = c.getContext("2d", { willReadFrequently: true });
    if (rotate) { g.translate(sh, 0); g.rotate(Math.PI / 2); }
    g.drawImage(img, 0, 0, sw, sh);
    return c;
  }
  async function decodePhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await imgFrom(url);
      const detector = await nativeDetector();
      if (detector) { try { const r = await detector.detect(img); if (r && r[0]) return r[0].rawValue; } catch (e) {} }
      if (!window.ZXing) throw new Error("The barcode reader didn't load. Reload the page and try again.");
      const ZX = window.ZXing; const reader = new ZX.MultiFormatReader(); reader.setHints(zxHints());
      for (const max of [1200, 800, 1800]) for (const rot of [false, true]) {
        try { const r = reader.decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(drawScaled(img, max, rot))))); if (r && r.getText()) return r.getText(); } catch (e) {}
      }
      return null;
    } finally { URL.revokeObjectURL(url); }
  }
  async function onPhoto(file) {
    if (!file) return;
    closeCamera();
    openSheet(`<h3>Reading barcode…</h3><p class="hint">Looking for the stripes in your photo.</p>`);
    let code = null, problem = "";
    try { code = await decodePhoto(file); } catch (e) { problem = e.message; }
    if (code) handleCode(cleanCode(code));
    else manualSheet(problem || "I couldn't find a barcode in that photo. Try again with the barcode filling most of the picture and good light, or type the numbers under the stripes.");
  }
  function manualSheet(message) {
    openSheet(`
      <h3>Type a barcode</h3>
      ${message ? `<div class="note">${esc(message)}</div>` : ""}
      <form id="manualForm" style="display:grid;gap:14px" novalidate>
        <label class="field">Barcode numbers<input id="m-code" inputmode="numeric" maxlength="40" autocomplete="off" placeholder="e.g. 5000168001234"></label>
        <div class="actions"><button type="button" class="btn" id="m-cam">Scan again</button><button type="submit" class="btn primary grow">Look up</button></div>
      </form>`, sheet => {
      $("#m-cam", sheet).onclick = openCamera;
      setTimeout(() => $("#m-code", sheet).focus(), 60);
      $("#manualForm", sheet).addEventListener("submit", e => { e.preventDefault(); const c = cleanCode($("#m-code", sheet).value); if (c) handleCode(c); });
    });
  }
  function handleCode(code) {
    if (!code) return;
    const matches = state.items.filter(i => i.barcode === code);
    if (matches.length) { foundSheet(code); return; }
    const known = state.products.get(code);
    if (known && known.name) {
      itemSheet(null, { barcode: code, name: known.name, unit: known.unit || "", source: known.source, brand: known.brand }, `Recognised <strong>${esc(known.name)}</strong>. Check the details and add it.`);
    } else {
      itemSheet(null, { barcode: code }, "", code);
    }
  }
  function foundSheet(code) {
    const matches = state.items.filter(i => i.barcode === code);
    if (!matches.length) { closeSheet(); return; }
    const first = matches[0];
    const rows = matches.map(it => `<div class="row"><div class="info" style="cursor:default"><div class="name">${esc(placeName(it.placeId))}</div><div class="meta">${useByTag(it) || (fmtDate(it.added) ? `<span>Added ${esc(fmtDate(it.added))}</span>` : "")}</div></div>
      <div class="qty"><button class="step" data-fd="dec" data-id="${esc(it.id)}" aria-label="Take one out" ${it.qty <= 0 ? "disabled" : ""}>−</button><output>${it.qty}</output><button class="step" data-fd="inc" data-id="${esc(it.id)}" aria-label="Put one in">+</button></div></div>`).join("");
    openSheet(`
      <h3>${esc(first.name)}</h3>
      <div class="code">${esc(code)}</div>
      <p class="hint">Tap − when you take one out, + when you put one in.</p>
      <div class="found">${rows}</div>
      <div class="actions">
        <button class="btn" id="fd-new">Add to another place</button>
        <button class="btn" id="fd-scan">Scan another</button>
        <button class="btn primary grow" id="fd-done">Done</button>
      </div>`, sheet => {
      $("#fd-done", sheet).onclick = closeSheet;
      $("#fd-scan", sheet).onclick = openCamera;
      $("#fd-new", sheet).onclick = () => itemSheet(null, { barcode: code, name: first.name, unit: first.unit || "" }, `Adding more <strong>${esc(first.name)}</strong> in a different place.`);
      sheet.addEventListener("click", e => {
        const b = e.target.closest("[data-fd]"); if (!b) return;
        changeQty(b.dataset.id, b.dataset.fd === "inc" ? 1 : -1);
        foundSheet(code);
      });
    });
  }

  // ---------- events ----------
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-act],[data-f]"); if (!b || b.closest(".sheet")) return;
    if (b.dataset.f) { state.filter = b.dataset.f; store.set("larder.filter", state.filter); render(); return; }
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "inc": changeQty(id, 1); break;
      case "dec": changeQty(id, -1); break;
      case "del": deleteItem(id); break;
      case "edit": itemSheet(id); break;
      case "places": placesSheet(); break;
      case "settings": settingsSheet(); break;
    }
  });
  $("#addBtn").addEventListener("click", () => itemSheet(null));
  $("#scanBtn").addEventListener("click", openCamera);
  $("#settingsBtn").addEventListener("click", settingsSheet);
  document.addEventListener("click", e => { if (e.target.closest('label[for="photoFile"]')) $("#photoFile").value = ""; }, true);
  $("#photoFile").addEventListener("change", e => onPhoto(e.target.files && e.target.files[0]));
  $("#search").addEventListener("input", e => { state.q = e.target.value; render(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  window.addEventListener("online", refresh);
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);

  // ---------- start ----------
  try {
    const cached = JSON.parse(store.get("larder.cache") || "null");
    if (cached && cached.url === state.url) { applySnapshot(cached); state.lastSync = null; }
  } catch (e) {}
  render();
  if (state.url) refresh(); else settingsSheet();
  window.__larder = { state, handleCode, lookupProduct }; // for testing
})();
