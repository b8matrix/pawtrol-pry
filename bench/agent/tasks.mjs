// Benchmark tasks. Each is phrased the way a user would type it, starts on a
// fixture site, and is graded on the final answer and/or the server state the
// agent left behind. Nothing here is referenced by the extension's prompts:
// these sites and tasks are held out.
//
// check({ answer, state, finalUrl }) → { pass: boolean, why: string }

const has = (text, ...patterns) => patterns.every((p) => (p instanceof RegExp ? p.test(text) : text.toLowerCase().includes(p.toLowerCase())));

export const TASKS = [
  // --- Email triage ---------------------------------------------------------
  {
    id: "mail-important",
    category: "email triage",
    start: "/mail",
    task: "Find the unread email that actually needs me to do something, and tell me who sent it and the deadline.",
    check: ({ answer }) => {
      const pass = has(answer, "Meera", /26/);
      return { pass, why: pass ? "named Meera Iyer and the 26 Sept deadline" : "did not name Meera Iyer + 26 Sept" };
    },
  },
  {
    id: "mail-count",
    category: "email triage",
    start: "/mail",
    task: "How many unread emails do I have from Dev Rao?",
    check: ({ answer }) => {
      const pass = /\b(3|three)\b/i.test(answer) && !/\b(2|two)\b\s+unread/i.test(answer);
      return { pass, why: pass ? "answered 3 (one is on page 2)" : "expected 3 (two on page 1, one on page 2)" };
    },
  },
  {
    id: "mail-archive",
    category: "email triage",
    start: "/mail",
    task: "Archive every email from ShopKart Deals.",
    check: ({ state }) => {
      const want = [1, 4, 12, 25];
      const got = [...state.mail.archived].sort((a, b) => a - b);
      const pass = want.every((id) => got.includes(id)) && got.every((id) => want.includes(id));
      return { pass, why: `archived [${got}] (want [${want}], one is on page 2)` };
    },
  },

  // --- Product research / comparison -----------------------------------------
  {
    id: "shop-best-mouse",
    category: "product comparison",
    start: "/shop",
    task: "Find the best-rated wireless mouse under ₹3,000 on this site and tell me its name and price.",
    check: ({ answer }) => {
      const pass = has(answer, "Kestrel Pro") && /2,?799/.test(answer);
      return { pass, why: pass ? "Kestrel Pro, ₹2,799" : "expected Kestrel Pro at ₹2,799 (higher-rated ones are wired or over budget)" };
    },
  },
  {
    id: "shop-compare-weight",
    category: "product comparison",
    start: "/shop",
    task: "Which is lighter, the Zephyr M2 or the Kestrel Pro, and by how many grams?",
    check: ({ answer }) => {
      const pass = has(answer, "Zephyr") && /\b18\s*(g|grams)\b/i.test(answer);
      return { pass, why: pass ? "Zephyr M2, 18 g lighter" : "expected Zephyr M2 (54 g) vs Kestrel Pro (72 g): 18 g" };
    },
  },
  {
    id: "shop-cart-monitor",
    category: "product comparison",
    start: "/shop",
    task: "Add the cheapest 27-inch monitor to my cart.",
    check: ({ state }) => {
      const cart = state.shop.cart;
      const pass = cart["vista-27q"] === 1 && Object.keys(cart).length === 1;
      return { pass, why: `cart ${JSON.stringify(cart)} (want only vista-27q)` };
    },
  },

  // --- Form filling -----------------------------------------------------------
  {
    id: "civic-book",
    category: "form filling",
    start: "/civic",
    task: "Book a passport appointment at the Pune office: the earliest afternoon slot available. Name Test User, mobile 9000000000.",
    check: ({ state }) => {
      const b = state.civic.bookings;
      const one = b.length === 1 ? b[0] : null;
      const pass =
        !!one && one.service === "passport" && one.office === "pune" && one.date === "2026-10-07" && one.time === "14:30" &&
        /test user/i.test(one.name ?? "") && (one.phone ?? "").replace(/\D/g, "") === "9000000000";
      return { pass, why: `bookings ${JSON.stringify(b)} (want pune 2026-10-07 14:30, Test User)` };
    },
  },
  {
    id: "civic-support",
    category: "form filling",
    start: "/civic",
    task: "My order A1234 arrived damaged. Send a support request about it, choosing the right topic.",
    check: ({ state }) => {
      const t = state.civic.tickets;
      const one = t.length === 1 ? t[0] : null;
      const pass = !!one && one.topic === "returns" && /A1234/i.test(`${one.order} ${one.message}`) && /damag/i.test(one.message ?? "");
      return { pass, why: `tickets ${JSON.stringify(t)} (want topic returns, A1234, mentions damage)` };
    },
  },

  // --- Search and summarise ----------------------------------------------------
  {
    id: "kb-bridge",
    category: "search and summarise",
    start: "/kb",
    task: "Using Openpedia, who designed the Tavira Harbor Bridge and in what year was it completed?",
    check: ({ answer }) => {
      const pass = has(answer, "Carvalho", /1931/);
      return { pass, why: pass ? "Inês Carvalho, 1931" : "expected Inês Carvalho, completed 1931 (opened 1932; railway bridge is a decoy)" };
    },
  },
  {
    id: "kb-longest-river",
    category: "search and summarise",
    start: "/kb",
    task: "According to Openpedia's list of rivers of Veloria, which river is the longest and how long is it?",
    check: ({ answer }) => {
      const pass = has(answer, "Sarn", /842/);
      return { pass, why: pass ? "Sarn, 842 km" : "expected Sarn, 842 km (table is unsorted; Brova is a decoy)" };
    },
  },
  {
    id: "kb-release-notes",
    category: "search and summarise",
    start: "/kb",
    task: "Look up the Lumen Editor release notes on Openpedia. Which version first added dark mode?",
    check: ({ answer }) => {
      const pass = /2\.7(\.0)?\b/.test(answer) && !/\b2\.5(\.0)?\b[^.]*first/i.test(answer);
      return { pass, why: pass ? "2.7.0" : "expected 2.7.0 (2.5.0 only added a darker sidebar)" };
    },
  },

  // --- Multi-step transaction ---------------------------------------------------
  {
    id: "tix-book",
    category: "multi-step booking",
    start: "/tix",
    task: "Book 2 tickets for Monsoon Letters in Pune tonight: the cheapest show starting after 7 pm, two seats next to each other. Stop at the payment page, don't pay.",
    check: ({ state }) => {
      const o = state.tix.order;
      const seats = o?.seats ?? [];
      const adjacent =
        seats.length === 2 && seats[0][0] === seats[1][0] && Math.abs(Number(seats[0].slice(1)) - Number(seats[1].slice(1))) === 1;
      const pass = !!o && o.show === "s3" && adjacent && o.paid === false;
      return { pass, why: `order ${JSON.stringify(o)} (want show s3 INOX 20:15 ₹260, 2 adjacent seats, unpaid)` };
    },
  },
];
