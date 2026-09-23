// Local fixture sites for the agent benchmark. Five small apps that behave like
// the kinds of sites users send the agent to (webmail, a shop, a booking desk,
// a wiki, a ticketing site), with fake brands so neither the prompt nor the
// model has been tuned for them. Server-side state (archives, carts, bookings,
// orders) lets tasks be graded on what the agent actually did.

import { createServer } from "node:http";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const rupees = (n) => `₹${n.toLocaleString("en-IN")}`;

function layout(title, brand, body, nav = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#222}
header{background:#1f3a5f;color:#fff;padding:10px 20px;display:flex;gap:20px;align-items:center}
header a{color:#fff}
main{padding:16px 24px;max-width:1000px}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
.unread td{font-weight:700}
.card{border:1px solid #ddd;border-radius:6px;padding:10px;margin:8px 0}
.muted{color:#777;font-size:13px}
.seat{width:34px;height:30px;margin:2px}
.seat[disabled]{background:#bbb}
.seat.sel{background:#2e7d32;color:#fff}
</style></head><body><header><strong>${esc(brand)}</strong>${nav}</header><main>${body}</main></body></html>`;
}

function readBodyMulti(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

// ---------------------------------------------------------------------------
// Postbox (webmail)
// ---------------------------------------------------------------------------

const EMAILS = [
  { id: 1, from: "ShopKart Deals", addr: "deals@shopkart.example", subject: "Mega Sale: 70% off headphones this weekend", date: "Sep 23", unread: true, body: "Grab the biggest discounts of the season. Offer ends Sunday." },
  { id: 2, from: "Unstop", addr: "noreply@unstop.example", subject: "Hackathon registrations closing soon!", date: "Sep 23", unread: true, body: "Hundreds of students have registered. Don't miss out on prizes worth ₹5 lakh." },
  { id: 3, from: "Meera Iyer", addr: "meera.iyer@northwind.example", subject: "Vendor contract needs your signature", date: "Sep 22", unread: true, body: "Hi, the vendor contract for the Pune office is waiting for your signature in DocuSign. Please sign it by Friday 26 September, otherwise the vendor onboarding slips to next quarter. Thanks, Meera (Finance)" },
  { id: 4, from: "ShopKart Deals", addr: "deals@shopkart.example", subject: "An item on your wishlist dropped in price", date: "Sep 22", unread: true, body: "The Aurora X9 Pro is now cheaper. Buy before stock runs out." },
  { id: 5, from: "Dev Rao", addr: "dev.rao@northwind.example", subject: "Lunch on Thursday?", date: "Sep 22", unread: true, body: "Want to grab lunch Thursday? No worries if you're busy." },
  { id: 6, from: "LinkedIn", addr: "messages@linkedin.example", subject: "You appeared in 9 searches this week", date: "Sep 21", unread: true, body: "See who's looking at your profile. Upgrade to Premium." },
  { id: 7, from: "Dev Rao", addr: "dev.rao@northwind.example", subject: "Re: Q3 roadmap slides", date: "Sep 21", unread: true, body: "Looks good to me, I added two comments on slide 4. FYI only, nothing needed from you." },
  { id: 8, from: "Payroll Team", addr: "payroll@northwind.example", subject: "Your September payslip is available", date: "Sep 20", unread: false, body: "Your payslip for September has been published." },
  { id: 9, from: "Dev Rao", addr: "dev.rao@northwind.example", subject: "Standup notes", date: "Sep 20", unread: false, body: "Notes from today's standup attached." },
  { id: 10, from: "GitHub", addr: "noreply@github.example", subject: "[northwind/app] CI passed on main", date: "Sep 20", unread: false, body: "All checks have passed." },
  { id: 11, from: "Anita Desai", addr: "anita.desai@northwind.example", subject: "Offsite agenda (final)", date: "Sep 19", unread: false, body: "Final agenda for the offsite is attached." },
  { id: 12, from: "ShopKart Deals", addr: "deals@shopkart.example", subject: "Your weekly picks", date: "Sep 19", unread: false, body: "Handpicked deals for you." },
  { id: 13, from: "Swiggy", addr: "orders@swiggy.example", subject: "Your order has been delivered", date: "Sep 18", unread: false, body: "Enjoy your meal!" },
  { id: 14, from: "HR Team", addr: "hr@northwind.example", subject: "Reminder: update your emergency contact", date: "Sep 18", unread: false, body: "Please keep your emergency contact up to date." },
  { id: 15, from: "Kiran Shah", addr: "kiran.shah@northwind.example", subject: "Design review moved to 4pm", date: "Sep 17", unread: false, body: "Heads up, the design review is now at 4pm." },
  { id: 16, from: "Medium Daily Digest", addr: "digest@medium.example", subject: "Stories picked for you", date: "Sep 17", unread: false, body: "Top stories today." },
  { id: 17, from: "Airtel", addr: "billing@airtel.example", subject: "Your bill is ready", date: "Sep 16", unread: false, body: "Your bill of ₹799 is ready. Autopay is on." },
  { id: 18, from: "Unstop", addr: "noreply@unstop.example", subject: "5 new internships for you", date: "Sep 16", unread: false, body: "New internships matching your profile." },
  { id: 19, from: "Anita Desai", addr: "anita.desai@northwind.example", subject: "Travel booking for offsite", date: "Sep 15", unread: false, body: "Travel is booked." },
  { id: 20, from: "GitHub", addr: "noreply@github.example", subject: "[northwind/app] New issue #231", date: "Sep 15", unread: false, body: "A new issue was opened." },
  // Page 2
  { id: 21, from: "Kiran Shah", addr: "kiran.shah@northwind.example", subject: "Welcome to the team!", date: "Sep 12", unread: false, body: "Welcome aboard." },
  { id: 22, from: "Dev Rao", addr: "dev.rao@northwind.example", subject: "Offsite photos", date: "Sep 11", unread: true, body: "Uploaded the offsite photos to the shared drive." },
  { id: 23, from: "Zomato", addr: "noreply@zomato.example", subject: "50% off tonight", date: "Sep 10", unread: false, body: "Order now." },
  { id: 24, from: "Payroll Team", addr: "payroll@northwind.example", subject: "Your August payslip is available", date: "Sep 5", unread: false, body: "Your payslip for August has been published." },
  { id: 25, from: "ShopKart Deals", addr: "deals@shopkart.example", subject: "Festive preview: early access", date: "Sep 4", unread: false, body: "Early access starts now." },
  { id: 26, from: "Anita Desai", addr: "anita.desai@northwind.example", subject: "Offsite venue options", date: "Sep 3", unread: false, body: "Three venues shortlisted." },
];
const MAIL_PAGE_SIZE = 20;

function mailApp(state, url, method, body) {
  const nav = `<a href="/mail">Inbox</a><a href="/mail?view=archive">Archive</a>`;
  if (url.pathname === "/mail/action" && method === "POST") {
    const ids = body.getAll("id").map(Number);
    const action = body.get("action");
    for (const id of ids) {
      if (action === "archive") state.mail.archived.add(id);
      if (action === "read") state.mail.read.add(id);
      if (action === "unread") state.mail.read.delete(id);
    }
    return { redirect: `/mail${body.get("page") ? `?page=${body.get("page")}` : ""}` };
  }
  const openMatch = url.pathname.match(/^\/mail\/m\/(\d+)$/);
  if (openMatch) {
    const mail = EMAILS.find((m) => m.id === Number(openMatch[1]));
    if (!mail) return { status: 404, html: layout("Not found", "Postbox", "Message not found", nav) };
    state.mail.read.add(mail.id);
    return {
      html: layout(`${mail.subject} - Postbox`, "Postbox", `
<p><a href="/mail">← Back to inbox</a></p>
<h2>${esc(mail.subject)}</h2>
<p><strong>${esc(mail.from)}</strong> &lt;${esc(mail.addr)}&gt; · ${esc(mail.date)}</p>
<div class="card">${esc(mail.body)}</div>
<form method="post" action="/mail/action"><input type="hidden" name="id" value="${mail.id}">
<button name="action" value="archive">Archive</button> <button name="action" value="unread">Mark as unread</button></form>`, nav),
    };
  }
  if (url.pathname !== "/mail") return null;
  const archiveView = url.searchParams.get("view") === "archive";
  const visible = EMAILS.filter((m) => state.mail.archived.has(m.id) === archiveView);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pages = Math.max(1, Math.ceil(visible.length / MAIL_PAGE_SIZE));
  const rows = visible.slice((page - 1) * MAIL_PAGE_SIZE, page * MAIL_PAGE_SIZE);
  const isUnread = (m) => m.unread && !state.mail.read.has(m.id);
  const table = rows
    .map(
      (m) => `<tr class="${isUnread(m) ? "unread" : ""}" aria-label="${isUnread(m) ? "unread, " : ""}${esc(m.from)}, ${esc(m.subject)}">
<td><input type="checkbox" name="id" value="${m.id}" form="bulk" aria-label="Select message from ${esc(m.from)}: ${esc(m.subject)}"></td>
<td>${esc(m.from)}</td><td><a href="/mail/m/${m.id}">${esc(m.subject)}</a> <span class="muted">— ${esc(m.body.slice(0, 50))}</span></td><td>${esc(m.date)}</td></tr>`,
    )
    .join("");
  const pager = `<p>${page > 1 ? `<a href="/mail?${archiveView ? "view=archive&" : ""}page=${page - 1}">Newer</a> ` : ""}Page ${page} of ${pages} (${visible.length} conversations) ${page < pages ? `<a href="/mail?${archiveView ? "view=archive&" : ""}page=${page + 1}">Older</a>` : ""}</p>`;
  return {
    html: layout(`${archiveView ? "Archive" : "Inbox"} - Postbox`, "Postbox", `
<h2>${archiveView ? "Archive" : "Inbox"}</h2>
<form id="bulk" method="post" action="/mail/action"><input type="hidden" name="page" value="${page}">
<button name="action" value="archive">Archive selected</button> <button name="action" value="read">Mark selected as read</button></form>
<table><thead><tr><th></th><th>From</th><th>Subject</th><th>Date</th></tr></thead><tbody>${table}</tbody></table>${pager}`, nav),
  };
}

// ---------------------------------------------------------------------------
// Gearly (shop)
// ---------------------------------------------------------------------------

const PRODUCTS = [
  // Mice. Relevance order below; Kestrel Pro (the answer to the budget task) sits on page 2.
  { slug: "aurora-x9-pro", cat: "mice", name: "Aurora X9 Pro", price: 6499, rating: 4.8, reviews: 2104, specs: { Connection: "Wireless (2.4 GHz + Bluetooth)", Weight: "63 g", DPI: "26,000", Battery: "90 h" } },
  { slug: "falcon-wired-elite", cat: "mice", name: "Falcon Elite", price: 1899, rating: 4.9, reviews: 871, specs: { Connection: "Wired (USB-C cable)", Weight: "58 g", DPI: "18,000", Battery: "—" } },
  { slug: "zephyr-m2", cat: "mice", name: "Zephyr M2", price: 2499, rating: 4.4, reviews: 982, specs: { Connection: "Wireless (2.4 GHz)", Weight: "54 g", DPI: "12,000", Battery: "70 h" } },
  { slug: "kestrel-lite", cat: "mice", name: "Kestrel Lite", price: 1499, rating: 4.2, reviews: 640, specs: { Connection: "Wireless (Bluetooth)", Weight: "81 g", DPI: "4,000", Battery: "12 months (AA)" } },
  { slug: "nimbus-go", cat: "mice", name: "Nimbus Go", price: 999, rating: 4.1, reviews: 1320, specs: { Connection: "Wireless (2.4 GHz)", Weight: "90 g", DPI: "1,600", Battery: "12 months (AA)" } },
  { slug: "orion-ergo", cat: "mice", name: "Orion Ergo Vertical", price: 3499, rating: 4.7, reviews: 1502, specs: { Connection: "Wireless (Bluetooth)", Weight: "120 g", DPI: "4,000", Battery: "70 days" } },
  { slug: "basic-optical", cat: "mice", name: "Basic Optical Mouse", price: 349, rating: 3.9, reviews: 5210, specs: { Connection: "Wired (USB-A)", Weight: "85 g", DPI: "1,000", Battery: "—" } },
  { slug: "pulse-rgb", cat: "mice", name: "Pulse RGB", price: 1299, rating: 4.5, reviews: 2210, specs: { Connection: "Wired (USB-A)", Weight: "75 g", DPI: "12,400", Battery: "—" } },
  { slug: "drift-silent", cat: "mice", name: "Drift Silent", price: 1199, rating: 4.3, reviews: 760, specs: { Connection: "Wireless (2.4 GHz)", Weight: "68 g", DPI: "2,400", Battery: "18 months (AA)" } },
  { slug: "aurora-x5", cat: "mice", name: "Aurora X5", price: 3999, rating: 4.6, reviews: 1180, specs: { Connection: "Wireless (2.4 GHz)", Weight: "69 g", DPI: "20,000", Battery: "80 h" } },
  { slug: "travelmate-mini", cat: "mice", name: "TravelMate Mini", price: 799, rating: 4.0, reviews: 410, specs: { Connection: "Wireless (Bluetooth)", Weight: "52 g", DPI: "1,200", Battery: "6 months (AAA)" } },
  { slug: "comet-pro-wired", cat: "mice", name: "Comet Pro", price: 2299, rating: 4.7, reviews: 690, specs: { Connection: "Wired (braided USB)", Weight: "61 g", DPI: "26,000", Battery: "—" } },
  { slug: "kestrel-pro", cat: "mice", name: "Kestrel Pro", price: 2799, rating: 4.6, reviews: 1544, specs: { Connection: "Wireless (2.4 GHz + Bluetooth)", Weight: "72 g", DPI: "16,000", Battery: "120 h" } },
  { slug: "glide-air", cat: "mice", name: "Glide Air", price: 2199, rating: 4.4, reviews: 520, specs: { Connection: "Wireless (2.4 GHz)", Weight: "59 g", DPI: "8,000", Battery: "60 h" } },
  { slug: "stellar-s1", cat: "mice", name: "Stellar S1", price: 2999, rating: 4.5, reviews: 330, specs: { Connection: "Wireless (Bluetooth)", Weight: "95 g", DPI: "4,000", Battery: "70 days" } },
  { slug: "tern-wireless", cat: "mice", name: "Tern", price: 1799, rating: 4.3, reviews: 205, specs: { Connection: "Wireless (2.4 GHz)", Weight: "66 g", DPI: "6,400", Battery: "50 h" } },
  // Monitors
  { slug: "vista-24f", cat: "monitors", name: "Vista 24F", price: 9990, rating: 4.3, reviews: 810, specs: { Size: "24 inch", Resolution: "1920 × 1080", Panel: "IPS", "Refresh rate": "75 Hz" } },
  { slug: "prism-27-4k", cat: "monitors", name: "Prism 27 4K", price: 27990, rating: 4.6, reviews: 402, specs: { Size: "27 inch", Resolution: "3840 × 2160", Panel: "IPS", "Refresh rate": "60 Hz" } },
  { slug: "vista-27q", cat: "monitors", name: "Vista 27Q", price: 14990, rating: 4.4, reviews: 690, specs: { Size: "27 inch", Resolution: "2560 × 1440", Panel: "IPS", "Refresh rate": "75 Hz" } },
  { slug: "arc-32c", cat: "monitors", name: "Arc 32C Curved", price: 21990, rating: 4.2, reviews: 280, specs: { Size: "32 inch", Resolution: "2560 × 1440", Panel: "VA", "Refresh rate": "165 Hz" } },
  { slug: "blaze-27g", cat: "monitors", name: "Blaze 27G Gaming", price: 18490, rating: 4.5, reviews: 1150, specs: { Size: "27 inch", Resolution: "2560 × 1440", Panel: "IPS", "Refresh rate": "170 Hz" } },
  { slug: "vista-22e", cat: "monitors", name: "Vista 22E", price: 7490, rating: 4.1, reviews: 1600, specs: { Size: "21.5 inch", Resolution: "1920 × 1080", Panel: "VA", "Refresh rate": "75 Hz" } },
  { slug: "office-27", cat: "monitors", name: "OfficeView 27", price: 15990, rating: 4.0, reviews: 190, specs: { Size: "27 inch", Resolution: "1920 × 1080", Panel: "VA", "Refresh rate": "60 Hz" } },
  // Keyboards
  { slug: "keystone-k2", cat: "keyboards", name: "Keystone K2", price: 5499, rating: 4.6, reviews: 980, specs: { Layout: "75%", Switches: "Brown", Connection: "Wireless" } },
  { slug: "typist-basic", cat: "keyboards", name: "Typist Basic", price: 699, rating: 4.0, reviews: 3200, specs: { Layout: "Full size", Switches: "Membrane", Connection: "Wired" } },
];
const SHOP_PAGE_SIZE = 12;
const isWireless = (p) => /^Wireless/.test(p.specs.Connection ?? "");

function shopApp(state, url, method, body) {
  const cartCount = Object.values(state.shop.cart).reduce((a, b) => a + b, 0);
  const nav = `<a href="/shop">Home</a><a href="/shop/c/mice">Mice</a><a href="/shop/c/keyboards">Keyboards</a><a href="/shop/c/monitors">Monitors</a><a href="/shop/cart">Cart (${cartCount})</a>
<form action="/shop/search" style="margin-left:auto"><input name="q" placeholder="Search Gearly" aria-label="Search Gearly"> <button>Search</button></form>`;
  const card = (p) => `<div class="card"><a href="/shop/p/${p.slug}"><strong>${esc(p.name)}</strong></a> — ${rupees(p.price)} · ★ ${p.rating} (${p.reviews.toLocaleString("en-IN")} reviews)</div>`;
  const render = (title, inner) => ({ html: layout(`${title} - Gearly`, "Gearly", inner, nav) });

  if (url.pathname === "/shop/cart/add" && method === "POST") {
    const slug = body.get("slug");
    if (PRODUCTS.some((p) => p.slug === slug)) state.shop.cart[slug] = (state.shop.cart[slug] ?? 0) + 1;
    return { redirect: "/shop/cart" };
  }
  if (url.pathname === "/shop/cart/remove" && method === "POST") {
    delete state.shop.cart[body.get("slug")];
    return { redirect: "/shop/cart" };
  }
  if (url.pathname === "/shop/cart") {
    const lines = Object.entries(state.shop.cart).map(([slug, qty]) => {
      const p = PRODUCTS.find((x) => x.slug === slug);
      return `<tr><td>${esc(p.name)}</td><td>${qty}</td><td>${rupees(p.price * qty)}</td><td><form method="post" action="/shop/cart/remove"><input type="hidden" name="slug" value="${slug}"><button>Remove</button></form></td></tr>`;
    });
    return render("Cart", `<h2>Your cart</h2>${lines.length ? `<table><tr><th>Item</th><th>Qty</th><th>Total</th><th></th></tr>${lines.join("")}</table><p><button disabled>Checkout (sign in required)</button></p>` : "<p>Your cart is empty.</p>"}`);
  }
  const productMatch = url.pathname.match(/^\/shop\/p\/([\w-]+)$/);
  if (productMatch) {
    const p = PRODUCTS.find((x) => x.slug === productMatch[1]);
    if (!p) return { status: 404, ...render("Not found", "Product not found") };
    const specs = Object.entries(p.specs).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
    return render(p.name, `<p class="muted"><a href="/shop/c/${p.cat}">${p.cat}</a> › ${esc(p.name)}</p>
<h2>${esc(p.name)}</h2><p><strong>${rupees(p.price)}</strong> · ★ ${p.rating} from ${p.reviews.toLocaleString("en-IN")} reviews · In stock</p>
<form method="post" action="/shop/cart/add"><input type="hidden" name="slug" value="${p.slug}"><button>Add to cart</button></form>
<h3>Specifications</h3><table>${specs}</table>
<h3>Customers also viewed</h3>${PRODUCTS.filter((x) => x.cat === p.cat && x.slug !== p.slug).slice(0, 3).map(card).join("")}`);
  }
  if (url.pathname === "/shop/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
    const words = q.split(/\s+/).filter(Boolean);
    const hits = PRODUCTS.filter((p) => words.length && words.every((w) => `${p.name} ${p.cat} ${Object.values(p.specs).join(" ")}`.toLowerCase().includes(w.replace(/s$/, ""))));
    return render(`Search: ${q}`, `<h2>Results for “${esc(q)}”</h2>${hits.length ? hits.slice(0, SHOP_PAGE_SIZE).map(card).join("") : "<p>No products found. Try a category instead.</p>"}${hits.length > SHOP_PAGE_SIZE ? `<p class="muted">Showing ${SHOP_PAGE_SIZE} of ${hits.length}. Use the category page to see all.</p>` : ""}`);
  }
  const catMatch = url.pathname.match(/^\/shop\/c\/(\w+)$/);
  if (catMatch) {
    const cat = catMatch[1];
    const sort = url.searchParams.get("sort") ?? "relevance";
    const wirelessOnly = url.searchParams.get("wireless") === "1";
    const max = Number(url.searchParams.get("max")) || Infinity;
    let list = PRODUCTS.filter((p) => p.cat === cat && p.price <= max && (!wirelessOnly || isWireless(p)));
    if (sort === "price-asc") list = [...list].sort((a, b) => a.price - b.price);
    if (sort === "price-desc") list = [...list].sort((a, b) => b.price - a.price);
    if (sort === "rating") list = [...list].sort((a, b) => b.rating - a.rating);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pages = Math.max(1, Math.ceil(list.length / SHOP_PAGE_SIZE));
    const qs = (extra) => {
      const params = new URLSearchParams(url.searchParams);
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return `?${params}`;
    };
    const filters = `<form class="card" action="/shop/c/${cat}">
${cat === "mice" ? `<label><input type="checkbox" name="wireless" value="1" ${wirelessOnly ? "checked" : ""}> Wireless only</label>` : ""}
<label>Max price (₹) <input name="max" type="number" value="${Number.isFinite(max) ? max : ""}"></label>
<label>Sort by <select name="sort">${[["relevance", "Relevance"], ["price-asc", "Price: low to high"], ["price-desc", "Price: high to low"], ["rating", "Customer rating"]].map(([v, l]) => `<option value="${v}" ${v === sort ? "selected" : ""}>${l}</option>`).join("")}</select></label>
<button>Apply</button></form>`;
    return render(cat, `<h2>${cat[0].toUpperCase() + cat.slice(1)}</h2>${filters}
${list.slice((page - 1) * SHOP_PAGE_SIZE, page * SHOP_PAGE_SIZE).map(card).join("") || "<p>No products match these filters.</p>"}
<p>Page ${page} of ${pages} ${page < pages ? `<a href="/shop/c/${cat}${qs({ page: page + 1 })}">Next page</a>` : ""}</p>`);
  }
  if (url.pathname === "/shop") {
    return render("Home", `<h2>Welcome to Gearly</h2><p>Shop <a href="/shop/c/mice">mice</a>, <a href="/shop/c/keyboards">keyboards</a> and <a href="/shop/c/monitors">monitors</a>.</p><h3>Trending</h3>${[PRODUCTS[0], PRODUCTS[17], PRODUCTS[23]].map(card).join("")}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CivicDesk (appointment booking + support form)
// ---------------------------------------------------------------------------

const OFFICES = { pune: "Pune", mumbai: "Mumbai", nagpur: "Nagpur" };
// Earliest Pune date has only morning slots left; the first afternoon slot is a day later.
const SLOTS = {
  pune: {
    "2026-10-05": [],
    "2026-10-06": ["09:30", "10:15", "11:00"],
    "2026-10-07": ["10:00", "14:30", "15:15"],
    "2026-10-08": ["13:00", "16:00"],
  },
  mumbai: { "2026-10-05": ["14:00", "15:00"], "2026-10-06": ["10:00"] },
  nagpur: { "2026-10-09": ["11:30", "14:00"] },
};
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function civicApp(state, url, method, body) {
  const nav = `<a href="/civic">Home</a><a href="/civic/book">Book appointment</a><a href="/civic/support">Support</a>`;
  const render = (title, inner) => ({ html: layout(`${title} - CivicDesk`, "CivicDesk Services", inner, nav) });
  if (url.pathname === "/civic") {
    return render("Home", `<h2>CivicDesk Services</h2><p>Book appointments for passport, licence and ID services, or contact support.</p><p><a href="/civic/book">Book an appointment</a> · <a href="/civic/support">Contact support</a></p>`);
  }
  if (url.pathname === "/civic/book") {
    const service = url.searchParams.get("service");
    const office = url.searchParams.get("office");
    if (!service || !office || !OFFICES[office]) {
      return render("Book", `<h2>Book an appointment</h2><form class="card" action="/civic/book">
<label>Service <select name="service"><option value="">Choose…</option><option value="passport">Passport services</option><option value="licence">Driving licence</option><option value="id">ID card</option></select></label>
<label>Office <select name="office"><option value="">Choose…</option>${Object.entries(OFFICES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
<button>Check availability</button></form>`);
    }
    const days = Object.entries(SLOTS[office]).map(([date, times]) => `<div class="card"><strong>${longDate(date)}</strong><br>${times.length ? times.map((t) => `<a href="/civic/book/details?service=${service}&office=${office}&date=${date}&time=${t}">${t}</a>`).join(" · ") : `<span class="muted">Fully booked</span>`}</div>`);
    return render("Availability", `<h2>${OFFICES[office]} office — available slots</h2><p class="muted">Pick a time to continue.</p>${days.join("")}`);
  }
  if (url.pathname === "/civic/book/details") {
    const p = Object.fromEntries(url.searchParams);
    const hidden = ["service", "office", "date", "time"].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] ?? "")}">`).join("");
    return render("Your details", `<h2>Your details</h2><p>${esc(OFFICES[p.office] ?? "")} office · ${esc(longDate(p.date))} at ${esc(p.time)}</p>
<form method="post" action="/civic/book/confirm" class="card">${hidden}
<p><label>Full name <input name="name" required></label></p><p><label>Mobile number <input name="phone" required></label></p>
<button>Confirm booking</button></form>`);
  }
  if (url.pathname === "/civic/book/confirm" && method === "POST") {
    const ref = `CD-${1000 + state.civic.bookings.length}`;
    state.civic.bookings.push({ ...Object.fromEntries(body), ref });
    return render("Booked", `<h2>Appointment booked</h2><p>Reference <strong>${ref}</strong>. ${esc(OFFICES[body.get("office")] ?? "")} office, ${esc(longDate(body.get("date")))} at ${esc(body.get("time"))}.</p>`);
  }
  if (url.pathname === "/civic/support") {
    if (method === "POST") {
      state.civic.tickets.push(Object.fromEntries(body));
      return render("Sent", `<h2>Thanks — your request was sent</h2><p>We usually reply within two working days.</p>`);
    }
    return render("Support", `<h2>Contact support</h2><form method="post" class="card">
<p><label>Topic <select name="topic"><option value="">Choose a topic…</option><option value="billing">Billing and payments</option><option value="returns">Returns, refunds and damaged items</option><option value="delivery">Delivery tracking</option><option value="account">Account and login</option><option value="other">Something else</option></select></label></p>
<p><label>Order number (optional) <input name="order"></label></p>
<p><label>How can we help? <textarea name="message" rows="4" cols="50"></textarea></label></p>
<button>Send request</button></form>`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Openpedia (wiki)
// ---------------------------------------------------------------------------

const filler = (topic, n) =>
  Array.from({ length: n }, (_, i) => `<p>${esc(topic)} has been the subject of study ${i + 1}: local historians describe the surrounding region, its trade routes, its seasonal festivals and the families who settled along the coast over several generations, often noting how the landscape shaped daily life.</p>`).join("");

const RIVERS = [
  ["Aldra", 311, "Northern hills", "Lake Mir"],
  ["Sarn", 842, "Kovan glacier", "Western Sea"],
  ["Tivel", 527, "Central plateau", "Sarn"],
  ["Oskar", 760, "Eastern range", "Gulf of Pell"],
  ["Mereth", 198, "Lake Mir", "Aldra"],
  ["Brova", 815, "Southern marshes", "Gulf of Pell"],
  ["Ilse", 402, "Kovan glacier", "Tivel"],
];

function releaseNotes() {
  const versions = [];
  for (let major = 3; major >= 1; major--) {
    for (let minor = 9; minor >= 0; minor--) {
      const v = `${major}.${minor}.0`;
      let items = ["Performance improvements when opening large files", "Fixed a crash when closing a split pane", "Updated translations"];
      if (v === "2.7.0") items = ["New: dark mode (Settings → Appearance → Theme)", "Fixed cursor jumping after undo", "Faster project search"];
      if (v === "2.8.0") items = ["Dark mode now follows the system theme", "Improved Markdown preview"];
      if (v === "3.1.0") items = ["Dark mode: higher-contrast syntax colours", "New command palette"];
      if (v === "2.5.0") items = ["Preview: a darker sidebar colour option (not a full dark mode)", "Plugin API v2"];
      versions.push(`<h3>Version ${v}</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`);
    }
  }
  return versions.join("");
}

const ARTICLES = {
  "tavira-harbor-bridge": {
    title: "Tavira Harbor Bridge",
    html: () => `<p>The <b>Tavira Harbor Bridge</b> is a steel arch bridge crossing the harbour mouth of Tavira. It carries road and tram traffic.</p>
${filler("The harbour", 6)}
<h3>History</h3><p>A crossing had been proposed since 1890. After a design competition in 1925, the commission went to the engineer <b>Inês Carvalho</b>, whose arch design beat eleven other entries. Construction began in 1927. The structure was completed in 1931, although the bridge only opened to traffic in March 1932 after load testing.</p>
${filler("The bridge", 4)}
<h3>See also</h3><p><a href="/kb/wiki/rivers-of-veloria">Rivers of Veloria</a></p>`,
  },
  "tavira-harbor-railway-bridge": {
    title: "Tavira Harbor Railway Bridge",
    html: () => `<p>The <b>Tavira Harbor Railway Bridge</b> is a truss bridge designed by António Mendes and completed in 1908. Not to be confused with the <a href="/kb/wiki/tavira-harbor-bridge">Tavira Harbor Bridge</a>.</p>${filler("The railway", 3)}`,
  },
  "rivers-of-veloria": {
    title: "List of rivers of Veloria",
    html: () => `<p>This is a list of the principal rivers of Veloria, in alphabetical order of source region.</p>
${filler("Veloria's hydrology", 3)}
<table><tr><th>River</th><th>Length (km)</th><th>Source</th><th>Mouth</th></tr>${RIVERS.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("")}</table>
<p>Note: the Brova is often cited as the longest river in popular guides, but that figure includes its estuary; the table uses river length only.</p>`,
  },
  "lumen-editor-release-notes": {
    title: "Lumen Editor release notes",
    html: () => `<p>Release history of the <b>Lumen</b> text editor, newest first.</p>${releaseNotes()}`,
  },
};

function kbApp(state, url) {
  const nav = `<a href="/kb">Main page</a><form action="/kb/search" style="margin-left:auto"><input name="q" placeholder="Search Openpedia" aria-label="Search Openpedia"> <button>Search</button></form>`;
  const render = (title, inner) => ({ html: layout(`${title} - Openpedia`, "Openpedia", inner, nav) });
  if (url.pathname === "/kb") return render("Main page", `<h2>Welcome to Openpedia</h2><p>The free encyclopedia of places that do not exist. Use the search box to find an article.</p>`);
  if (url.pathname === "/kb/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const words = q.split(/\W+/).filter((w) => w.length > 2);
    const hits = Object.entries(ARTICLES).filter(([, a]) => words.some((w) => `${a.title} ${a.html()}`.toLowerCase().includes(w)));
    return render(`Search`, `<h2>Search results</h2>${hits.map(([slug, a]) => `<div class="card"><a href="/kb/wiki/${slug}">${esc(a.title)}</a><div class="muted">${esc(a.html().replace(/<[^>]+>/g, "").slice(0, 140))}…</div></div>`).join("") || "<p>No results.</p>"}`);
  }
  const m = url.pathname.match(/^\/kb\/wiki\/([\w-]+)$/);
  if (m && ARTICLES[m[1]]) return render(ARTICLES[m[1]].title, `<h2>${esc(ARTICLES[m[1]].title)}</h2>${ARTICLES[m[1]].html()}`);
  return null;
}

// ---------------------------------------------------------------------------
// ShowSeat (movie tickets)
// ---------------------------------------------------------------------------

const MOVIES = { "monsoon-letters": "Monsoon Letters", "iron-tide": "Iron Tide", "the-quiet-hour": "The Quiet Hour" };
const SHOWS = [
  { id: "s1", city: "pune", movie: "monsoon-letters", theatre: "Cinepolis Seasons Mall", time: "18:30", price: 220 },
  { id: "s2", city: "pune", movie: "monsoon-letters", theatre: "PVR Phoenix Marketcity", time: "19:45", price: 340 },
  { id: "s3", city: "pune", movie: "monsoon-letters", theatre: "INOX Bund Garden", time: "20:15", price: 260 },
  { id: "s4", city: "pune", movie: "monsoon-letters", theatre: "City Pride Kothrud", time: "21:30", price: 280 },
  { id: "s5", city: "pune", movie: "iron-tide", theatre: "City Pride Kothrud", time: "19:00", price: 180 },
  { id: "s6", city: "mumbai", movie: "monsoon-letters", theatre: "PVR Juhu", time: "20:00", price: 199 },
];
const TAKEN = new Set(["A3", "A4", "B5", "C1", "C2", "C3", "D6", "E4", "E5"]);

function tixApp(state, url, method, body) {
  const city = state.tix.city;
  const nav = `<a href="/tix">Home</a><span>City: ${city ? esc(city[0].toUpperCase() + city.slice(1)) : "not selected"}</span><a href="/tix/city">Change city</a>`;
  const render = (title, inner) => ({ html: layout(`${title} - ShowSeat`, "ShowSeat", inner, nav) });
  if (url.pathname === "/tix/city") {
    if (url.searchParams.get("c")) {
      state.tix.city = url.searchParams.get("c");
      return { redirect: "/tix" };
    }
    return render("Choose city", `<h2>Select your city</h2>${["mumbai", "pune", "delhi", "bengaluru"].map((c) => `<a class="card" style="display:inline-block" href="/tix/city?c=${c}">${c[0].toUpperCase() + c.slice(1)}</a>`).join(" ")}`);
  }
  if (url.pathname === "/tix") {
    if (!city) return render("Home", `<h2>Movies near you</h2><p>Select your city to see what's playing. <a href="/tix/city">Choose city</a></p>`);
    const playing = [...new Set(SHOWS.filter((s) => s.city === city).map((s) => s.movie))];
    return render("Home", `<h2>Now showing</h2>${playing.map((m) => `<div class="card"><a href="/tix/movie/${m}">${MOVIES[m]}</a></div>`).join("") || "<p>Nothing showing in your city.</p>"}`);
  }
  const movieMatch = url.pathname.match(/^\/tix\/movie\/([\w-]+)$/);
  if (movieMatch) {
    if (!city) return { redirect: "/tix/city" };
    const shows = SHOWS.filter((s) => s.city === city && s.movie === movieMatch[1]);
    return render(MOVIES[movieMatch[1]] ?? "Movie", `<h2>${esc(MOVIES[movieMatch[1]] ?? "")}</h2><p class="muted">Tonight's shows</p>
${shows.map((s) => `<div class="card"><strong>${esc(s.theatre)}</strong><br><a href="/tix/seats/${s.id}">${s.time}</a> · ${rupees(s.price)} per ticket</div>`).join("")}`);
  }
  const seatsMatch = url.pathname.match(/^\/tix\/seats\/(\w+)$/);
  if (seatsMatch) {
    const show = SHOWS.find((s) => s.id === seatsMatch[1]);
    if (!show) return null;
    const rows = ["A", "B", "C", "D", "E"].map((r) => `<div>${r} ${Array.from({ length: 8 }, (_, i) => `${r}${i + 1}`).map((seat) => `<button type="button" class="seat" data-seat="${seat}" aria-label="Seat ${seat}${TAKEN.has(seat) ? " (sold)" : ""}" aria-pressed="false" ${TAKEN.has(seat) ? "disabled" : ""}>${seat.slice(1)}</button>`).join("")}</div>`).join("");
    return render("Seats", `<h2>${esc(MOVIES[show.movie])} — ${esc(show.theatre)}, ${show.time}</h2><p>${rupees(show.price)} per ticket. Grey seats are sold. Row A is nearest the screen.</p>
<div id="seats">${rows}</div><p>Selected: <span id="sel">none</span></p>
<form method="post" action="/tix/hold"><input type="hidden" name="show" value="${show.id}"><input type="hidden" name="seats" id="seats-field"><button id="proceed" disabled>Proceed to payment</button></form>
<script>
const chosen = new Set();
document.getElementById("seats").addEventListener("click", (e) => {
  const b = e.target.closest("button.seat"); if (!b || b.disabled) return;
  const s = b.dataset.seat; chosen.has(s) ? chosen.delete(s) : chosen.add(s);
  b.classList.toggle("sel", chosen.has(s)); b.setAttribute("aria-pressed", String(chosen.has(s)));
  document.getElementById("sel").textContent = [...chosen].join(", ") || "none";
  document.getElementById("seats-field").value = [...chosen].join(",");
  document.getElementById("proceed").disabled = chosen.size === 0;
});
</script>`);
  }
  if (url.pathname === "/tix/hold" && method === "POST") {
    const show = SHOWS.find((s) => s.id === body.get("show"));
    const seats = (body.get("seats") ?? "").split(",").filter(Boolean);
    state.tix.order = { show: show?.id, seats, paid: false };
    return { redirect: "/tix/payment" };
  }
  if (url.pathname === "/tix/payment") {
    const order = state.tix.order;
    if (!order) return { redirect: "/tix" };
    if (method === "POST") {
      order.paid = true;
      return render("Paid", `<h2>Payment successful</h2>`);
    }
    const show = SHOWS.find((s) => s.id === order.show);
    return render("Payment", `<h2>Review and pay</h2><div class="card">${esc(MOVIES[show.movie])} · ${esc(show.theatre)} · ${show.time}<br>Seats: ${order.seats.join(", ")}<br>Total: ${rupees(show.price * order.seats.length + 60)} (incl. ₹60 convenience fee)</div>
<form method="post"><p><label>Card number <input name="card" autocomplete="cc-number"></label></p><button>Pay now</button></form>`);
  }
  return null;
}

// ---------------------------------------------------------------------------

export function freshState() {
  return {
    mail: { archived: new Set(), read: new Set() },
    shop: { cart: {} },
    civic: { bookings: [], tickets: [] },
    tix: { city: null, order: null },
  };
}

export async function startSites() {
  let state = freshState();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = req.method === "POST" ? await readBodyMulti(req) : new URLSearchParams();
    let out = null;
    try {
      for (const app of [mailApp, shopApp, civicApp, kbApp, tixApp]) {
        out = app(state, url, req.method, body);
        if (out) break;
      }
    } catch (error) {
      out = { status: 500, html: `<pre>${esc(error.stack)}</pre>` };
    }
    if (!out) return res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    if (out.redirect) return res.writeHead(303, { location: out.redirect }).end();
    res.writeHead(out.status ?? 200, { "content-type": "text/html; charset=utf-8" }).end(out.html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get state() {
      return state;
    },
    reset() {
      state = freshState();
    },
    close: () => server.close(),
  };
}

export const FIXTURES = { EMAILS, PRODUCTS, SLOTS, SHOWS, TAKEN, RIVERS };
