const products = [
  ["uv-k5", "Quansheng UV-K5", "A flexible dual-band handheld with a huge community firmware ecosystem. A short radio-readiness check is required before fulfilment.", 35, 40, "/assets/radio_img.png", "radios", 10],
  ["uv-5r", "Baofeng UV-5R", "The classic beginner handheld: compact, well documented, and easy to experiment with. A short radio-readiness check is required before fulfilment.", 30, 40, "/assets/radio_img.png", "radios", 20],
  ["yagi-kit", "Tape-measure Yagi kit", "Everything needed to build a portable directional antenna for satellites and the ISS.", 20, 60, "/assets/antenna_img.png", "build kits", 30],
  ["rtl-sdr", "RTL-SDR receiver", "Listen to repeaters, satellites, weather stations, and the ISS from a computer.", 45, 35, "/assets/sattelite.png", "receivers", 40],
  ["licence-grant", "Amateur radio licence grant", "Funding toward your local amateur-radio exam or licence fees, issued as a grant through HCB. The amount and process depend on your country.", 100, 25, "/assets/waveform.jpeg", "licence support", 50],
];

const countries = [
  {
    code: "AU", name: "Australia",
    ownershipRule: "Receiving equipment may be owned, but transmitters and their use must comply with Australian equipment and amateur-radio rules.",
    transmissionRule: "Do not transmit until you hold the required amateur qualification and callsign.",
    fulfilmentMode: "local", fulfilmentNote: "Prefer local Australian fulfilment where stock permits.",
    sourceUrl: "https://www.acma.gov.au/amateur-radio", sortOrder: 10,
  },
  {
    code: "GB", name: "United Kingdom",
    ownershipRule: "Equipment ownership and use are different questions; transmitting on amateur bands requires the appropriate Ofcom licence.",
    transmissionRule: "Pass the relevant exam and obtain an Ofcom amateur-radio licence before transmitting.",
    fulfilmentMode: "customs", fulfilmentNote: "Check model compliance, availability, VAT, and customs before fulfilment.",
    sourceUrl: "https://www.ofcom.org.uk/spectrum/radio-equipment/amateur-radio", sortOrder: 20,
  },
  {
    code: "CA", name: "Canada",
    ownershipRule: "Receiving and possessing equipment does not by itself authorise transmission.",
    transmissionRule: "An amateur radio operator certificate and suitable qualification are required before transmitting.",
    fulfilmentMode: "customs", fulfilmentNote: "Check Canadian availability, device compliance, duties, and carrier restrictions.",
    sourceUrl: "https://ised-isde.canada.ca/site/spectrum-management-telecommunications/en/licences-and-certificates/radio-authorizations/amateur-radio-operator-certification", sortOrder: 30,
  },
  {
    code: "NZ", name: "New Zealand",
    ownershipRule: "Some radio equipment can be owned or received with, but supply and use of transmitting equipment remain regulated.",
    transmissionRule: "Do not transmit on amateur frequencies without the current operator qualification and callsign required in New Zealand.",
    fulfilmentMode: "manual_review", fulfilmentNote: "An organizer must check the exact radio model and local supply rules before fulfilment.",
    sourceUrl: "https://www.rsm.govt.nz/licensing/frequencies-for-anyone/amateur-radio-operators", sortOrder: 40,
  },
  {
    code: "IN", name: "India",
    ownershipRule: "Possession, import, and sale of wireless transmitting equipment can require additional permissions.",
    transmissionRule: "Do not transmit without the amateur-station authorisation required by Indian authorities.",
    fulfilmentMode: "manual_review", fulfilmentNote: "All transmitting-radio orders require organizer review before purchase or shipment.",
    sourceUrl: "https://eservices.dot.gov.in/dealer-possession-license", sortOrder: 50,
  },
  {
    code: "US", name: "United States",
    ownershipRule: "Equipment may generally be owned, but the device and its operation must comply with FCC rules.",
    transmissionRule: "An FCC amateur licence with appropriate privileges is required before transmitting on amateur bands.",
    fulfilmentMode: "standard", fulfilmentNote: "Check model compliance and domestic availability before fulfilment.",
    sourceUrl: "https://www.fcc.gov/wireless/bureau-divisions/mobility-division/amateur-radio-service", sortOrder: 60,
  },
  {
    code: "OTHER", name: "Another country or territory",
    ownershipRule: "Rules differ by location and equipment type.",
    transmissionRule: "Do not transmit until you have checked the rules and obtained any authorisation required where you live.",
    fulfilmentMode: "manual_review", fulfilmentNote: "An organizer will review local availability, customs, and radio rules before fulfilment.",
    sourceUrl: "", sortOrder: 999,
  },
];

export async function seedStore(store) {
  const [existingProducts, existingCountries] = await Promise.all([
    store.list("product"),
    store.list("country"),
  ]);
  const existingProductIds = new Set(existingProducts.map((product) => product.id));
  const missingProducts = products.filter(([id]) => !existingProductIds.has(id));
  if (missingProducts.length) {
    await Promise.all(missingProducts.map(async ([id, name, description, price, stock, image, category, sortOrder]) => {
      await store.put("product", id, { id, name, description, price, stock, image, category, sortOrder, active: true });
    }));
  }
  if (!existingCountries.length) {
    await Promise.all(countries.map(async (country) => {
      await store.put("country", country.code, {
        id: country.code,
        ...country,
        active: true,
        updatedAt: new Date().toISOString(),
      });
    }));
  }
}
