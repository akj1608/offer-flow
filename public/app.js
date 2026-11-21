const form = document.querySelector("#search");
const citySelect = document.querySelector("#city");
const checkIn = document.querySelector("#check-in");
const checkOut = document.querySelector("#check-out");
const guests = document.querySelector("#guests");
const minPrice = document.querySelector("#min-price");
const maxPrice = document.querySelector("#max-price");
const sort = document.querySelector("#sort");
const failProvider = document.querySelector("#fail-provider");
const submit = document.querySelector("#submit");
const banner = document.querySelector("#banner");
const summary = document.querySelector("#summary");
const offers = document.querySelector("#offers");
const headersPanel = document.querySelector("#headers");
const headerList = document.querySelector("#header-list");
const redisPill = document.querySelector("#redis-pill");

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const HEADER_NAMES = [
  "x-cache",
  "x-cache-reason",
  "x-cache-key",
  "x-cache-age",
  "x-offers-before-dedupe",
  "x-offers-after-dedupe",
  "x-providers-ok",
  "x-providers-failed",
  "x-request-id",
  "x-response-time-ms",
  "cache-control",
  "server-timing",
];

function utcDay(offset) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
    .toISOString()
    .slice(0, 10);
}

checkIn.value = utcDay(1);
checkOut.value = utcDay(3);

function text(value) {
  return document.createTextNode(value == null ? "" : String(value));
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.appendChild(text(content));
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function showBanner(message) {
  banner.hidden = false;
  clear(banner);
  banner.appendChild(text(message));
}

function hideBanner() {
  banner.hidden = true;
  clear(banner);
}

async function refreshRedis() {
  try {
    const response = await fetch("/health");
    const body = await response.json();
    const ok = body.redis && body.redis.ok;
    redisPill.className = ok ? "pill up" : "pill down";
    clear(redisPill);
    if (ok) {
      redisPill.appendChild(text(`Redis up · ${body.redis.latencyMs} ms`));
    } else {
      const code = body.redis && body.redis.code ? body.redis.code : "unreachable";
      redisPill.appendChild(text(`Redis down · cache bypassed · ${code}`));
    }
  } catch {
    redisPill.className = "pill down";
    clear(redisPill);
    redisPill.appendChild(text("Health check failed"));
  }
}

async function loadCities() {
  try {
    const response = await fetch("/v1/providers");
    if (!response.ok) return;
    const body = await response.json();
    const current = citySelect.value;
    clear(citySelect);
    for (const city of body.cities || []) {
      const option = document.createElement("option");
      option.value = city.name;
      option.appendChild(text(city.name));
      citySelect.appendChild(option);
    }
    const jaipur = document.createElement("option");
    jaipur.value = "Jaipur";
    jaipur.appendChild(text("Jaipur (no inventory)"));
    citySelect.appendChild(jaipur);
    if ([...citySelect.options].some((option) => option.value === current)) citySelect.value = current;
  } catch {
    // The markup already lists the cities.
  }
}

function renderSummary(body) {
  summary.hidden = false;
  clear(summary);
  const badge = el("p", `badge ${body.meta.cache}`, body.meta.cache);
  const copy = el("div");
  const title = el(
    "p",
    "",
    `${body.query.city} · ${body.query.checkIn} to ${body.query.checkOut} · ${body.query.nights} nights · ${body.query.guests} guests`,
  );
  const detail = el(
    "p",
    "hint",
    `${body.meta.offersBeforeDedupe} provider quotes became ${body.meta.offersAfterDedupe} hotels. Showing ${body.meta.returned}. ${body.meta.cacheReason.replaceAll("_", " ")}. ${body.meta.tookMs} ms.`,
  );
  copy.append(title, detail);
  if (body.meta.providersFailed.length > 0) {
    const failed = body.meta.providersFailed
      .map((item) => `${item.provider} (${item.message})`)
      .join(", ");
    copy.appendChild(el("p", "hint", `Degraded providers: ${failed}.`));
  }
  summary.append(badge, copy);
}

function renderOffer(offer) {
  const card = el("article", offer.savingsVsNext > 0 ? "offer saved" : "offer");
  card.appendChild(el("p", "kicker", `${offer.stars}-star · ${offer.guestRating.toFixed(1)} · ${offer.board}`));
  card.appendChild(el("h3", "", offer.name));
  card.appendChild(el("p", "where", offer.city));
  const price = el("p", "price", money.format(offer.totalPrice));
  price.appendChild(el("span", "", `${money.format(offer.nightlyRate)} / night · ${offer.providerName}`));
  card.appendChild(price);
  if (offer.savingsVsNext > 0 && offer.alternatives[0]) {
    card.appendChild(
      el("p", "save", `${money.format(offer.savingsVsNext)} under ${offer.alternatives[0].providerName}`),
    );
  } else if (offer.alternatives.length === 0) {
    card.appendChild(el("p", "only", `Only ${offer.providerName} sells this stay.`));
  } else {
    card.appendChild(el("p", "only", "Same total. Kept the higher guest rating."));
  }

  const quotes = document.createElement("ul");
  quotes.className = "quotes";
  const rows = [
    {
      providerName: offer.providerName,
      totalPrice: offer.totalPrice,
      winner: true,
    },
    ...offer.alternatives.map((alternative) => ({
      providerName: alternative.providerName,
      totalPrice: alternative.totalPrice,
      winner: false,
    })),
  ];
  for (const row of rows) {
    const item = document.createElement("li");
    if (row.winner) item.className = "winner";
    const name = document.createElement("span");
    name.appendChild(text(row.winner ? `${row.providerName} · selected` : row.providerName));
    const amount = document.createElement("span");
    amount.className = "amount";
    amount.appendChild(text(money.format(row.totalPrice)));
    item.append(name, amount);
    quotes.appendChild(item);
  }
  card.appendChild(quotes);

  if (offer.amenities.length > 0) {
    const amenities = document.createElement("ul");
    amenities.className = "amenities";
    for (const amenity of offer.amenities) amenities.appendChild(el("li", "", amenity));
    card.appendChild(amenities);
  }
  return card;
}

function renderHeaders(response) {
  headersPanel.hidden = false;
  clear(headerList);
  for (const name of HEADER_NAMES) {
    const value = response.headers.get(name);
    if (!value) continue;
    headerList.append(el("dt", "", name), el("dd", "", value));
  }
}

function renderOffers(body) {
  clear(offers);
  if (!body.offers.length) {
    const empty = el(
      "p",
      "empty",
      `No stays in ${body.query.city} for these dates. An empty result is still cached, so the next identical search can be a hit.`,
    );
    offers.appendChild(empty);
    return;
  }
  const grid = el("div", "offers-grid");
  for (const offer of body.offers) grid.appendChild(renderOffer(offer));
  offers.appendChild(grid);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideBanner();
  submit.disabled = true;
  submit.textContent = "Asking Atlas and Nimbus…";
  const params = new URLSearchParams({
    city: citySelect.value,
    checkIn: checkIn.value,
    checkOut: checkOut.value,
    guests: guests.value,
    sort: sort.value,
  });
  if (minPrice.value) params.set("minPrice", minPrice.value);
  if (maxPrice.value) params.set("maxPrice", maxPrice.value);
  if (failProvider.value) params.set("failProvider", failProvider.value);
  try {
    const response = await fetch(`/v1/offers?${params}`);
    const body = await response.json();
    if (!response.ok) {
      const message = body.error && body.error.message ? body.error.message : "Search failed.";
      showBanner(message);
      summary.hidden = true;
      headersPanel.hidden = true;
      clear(offers);
      return;
    }
    renderSummary(body);
    renderOffers(body);
    renderHeaders(response);
    const offersTop = offers.getBoundingClientRect().top;
    if (offersTop > window.innerHeight * 0.45) {
      offers.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch {
    showBanner("The desk could not reach the API.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Search offers";
    void refreshRedis();
  }
});

void loadCities();
void refreshRedis();
setInterval(() => {
  void refreshRedis();
}, 5000);
