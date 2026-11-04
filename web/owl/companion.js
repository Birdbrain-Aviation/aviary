// Owl's side of the phone companion: the window that turns sharing on and
// shows the QR codes, and the feed that sends the live readouts to the phone
// (through Owl's local server, which serves the companion app on the network).

import { h, clear, modal, toast } from "/shared/js/ui.js";
import { drawQR } from "/shared/js/qr.js";

let started = false, lastSent = 0, sending = false, helpOpen = false;

// Called four times a second: keep sharing on if it was on, and send the state.
export async function companionTick(ctx) {
  const c = ctx.set.companion;
  if (!c?.on) return;
  if (!started) {
    started = true;
    try { await ctx.host.post("/api/companion", { on: true }); } catch { started = false; return; }
  }
  if (sending) return;
  sending = true;
  try {
    await fetch("/api/companion/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ctx.snapshot()) });
    lastSent = performance.now();
  } catch { /* the window is closing */ }
  sending = false;
}

export function openCompanion(ctx) {
  const { set, host } = ctx;
  set.companion ||= { on: false };
  const body = h("div", { class: "companion" });
  let st = null, timer = null;
  const toggle = async (on, newKey = false) => {
    try {
      st = await host.post("/api/companion", { on, newKey });
      set.companion.on = st.on; set.save();
      started = st.on;
      if (on && !st.on && st.error) toast(st.error, "fault", 8000);
    } catch (e) { toast("Couldn't change sharing: " + e.message, "fault"); }
    draw();
  };
  const draw = () => {
    clear(body);
    const on = !!st?.on;
    body.append(h("p", { style: { marginTop: 0 } }, "See Owl's readouts on your phone, and walk to the rocket with an arrow from the phone's own GPS and compass. The arrow keeps working out of Wi-Fi range, from the rocket's last position."),
      h("label", { class: "check big-check" }, h("input", { type: "checkbox", checked: on, onchange: (e) => toggle(e.target.checked) }), "Share with phones on this network"));
    if (st?.error) body.append(h("div", { class: "safety" }, st.error));
    if (!on) {
      body.append(h("p", { class: "note" }, "Your phone and this laptop must be on the same network. At the field, turn on your iPhone's Personal Hotspot and join it from the laptop. Windows may ask to let Owl through the firewall: allow it (on public networks too, since hotspots count as public)."));
      return;
    }
    const urls = st.urls || [];
    if (!urls.length) { body.append(h("div", { class: "safety" }, "This computer isn't on a network. Join the same Wi-Fi as your phone, or your phone's hotspot.")); return; }
    const pick = urls.find((u) => u.ip === set.companion.ip) || urls[0];
    // firewall: the usual reason a phone can't open the page
    const fw = st.firewall || {};
    if (fw.windows && fw.known && !fw.allowed) {
      body.append(h("div", { class: "safety cp-fw" },
        h("div", null, h("b", null, "Windows Firewall may be blocking your phone. "), "Owl needs to accept connections on ports 47711 and 47712."),
        h("button", { class: "btn small primary", onclick: async () => {
          try { st = await host.post("/api/companion/firewall", {}); toast("Approve the Windows prompt; Owl checks again in a few seconds."); } catch (e) { toast(e.message, "fault", 9000); }
          draw();
        } }, "Let phones through the firewall")));
    } else if (fw.windows && fw.allowed) body.append(h("div", { class: "note cp-ok" }, "✓ Windows Firewall lets phones in."));
    const qr = (text, title, note) => {
      const cv = h("canvas", { "aria-label": title });
      try { drawQR(cv, text); } catch { /* */ }
      return h("div", { class: "cp-qr" }, h("b", null, title), cv, h("div", { class: "mono small-url" }, text.replace(/\?k=.*/, "")), h("div", { class: "note" }, note));
    };
    body.append(h("div", { class: "cp-qrs" },
      qr(pick.setup, "1. First time on this phone", "Scan with the iPhone camera. It walks you through trusting Owl's certificate, which the GPS and compass need."),
      qr(pick.app, "2. Open the companion", "Then in Safari: Share › Add to Home Screen. Next time just tap the Owl icon.")));
    // which address the codes use
    if (urls.length > 1) {
      body.append(h("div", { class: "cp-addrs" }, h("span", { class: "k" }, "Address in the codes"),
        h("select", { onchange: (e) => { set.companion.ip = e.target.value; set.save(); draw(); } },
          urls.map((u) => h("option", { value: u.ip, selected: u.ip === pick.ip }, `${u.ip}  (${u.iface}${u.primary ? ", main connection" : ""})`))),
        h("span", { class: "note" }, "If the page won't open on the phone, try another address: pick the one on the same Wi-Fi as the phone.")));
    }
    const c = st.contact;
    const contact = c ? `${c.what} from ${c.ip}, ${Math.max(0, Math.round((Date.now() - c.at) / 1000))} s ago` : "none yet";
    body.append(h("div", { class: "kv cp-kv" },
        h("span", { class: "k" }, "Pairing code"), h("span", { class: "mono" }, st.key),
        h("span", { class: "k" }, "Last phone contact"), h("span", { class: c ? "" : "muted" }, contact),
        h("span", { class: "k" }, "Phones connected"), h("span", null, String(st.phones || 0))),
      h("details", { class: "cp-help", open: helpOpen, ontoggle: (e) => { helpOpen = e.target.open; } }, h("summary", null, "The page won't open on the phone"),
        h("ul", null,
          h("li", null, "“Last phone contact” stays at none: the phone never reached this computer. Check the phone is on the same Wi-Fi (not cellular, not a guest network), allow Owl through the firewall above, and try another address."),
          h("li", null, "Some routers keep Wi-Fi devices apart (“AP isolation” or “client isolation”). Turn on the iPhone's Personal Hotspot and connect this computer to it instead; that always works."),
          h("li", null, "The setup page opens but the companion shows “This Connection Is Not Private”: finish steps 2 and 3 on the setup page (install the profile, then turn it on in Certificate Trust Settings)."),
          h("li", null, "Scan with the Camera app, then tap the yellow link; some QR apps open their own browser, which can't use the certificate."))),
      h("p", { class: "note" }, "The home screen app is tied to this computer's address on this network, so set it up on the network you'll use at the field. Phones only see the readouts; they can't change anything here."),
      h("div", { class: "row" }, h("button", { class: "btn small", onclick: () => toggle(true, true) }, "New pairing code"), h("span", { class: "note" }, "Disconnects phones paired with the old code.")));
  };
  // don't redraw under an open address list
  const refresh = async () => { try { st = await host.get("/api/companion"); } catch { /* */ } if (document.activeElement?.tagName === "SELECT" && body.contains(document.activeElement)) return; draw(); };
  refresh();
  timer = setInterval(refresh, 2500);
  modal({ title: "Phone companion", body, wide: true, onClose: () => clearInterval(timer), actions: [{ label: "Done", kind: "primary" }] });
}
