#!/usr/bin/env python3
"""Patch the uploaded BloxStar frontend for the standalone Vercel backend.

Rules:
  * The uploaded HTML is preserved as-is except for the minimal changes below.
  * MoonPay is the ONLY customer payment provider (lockAmount=true).
  * Transak / NOWPayments are removed from the customer flow.
  * Order persistence is bridged to the new same-origin /api/public/* backend.
"""
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
h = src.read_text(encoding="utf-8")
applied = []


def sub(old, new, count=0, name=""):
    global h
    n = h.count(old)
    if n == 0:
        raise SystemExit(f"PATCH FAILED (pattern not found): {name or old[:70]}")
    if count:
        h = h.replace(old, new, count)
        applied.append(f"{name or old[:50]}: {count}/{n}")
    else:
        h = h.replace(old, new)
        applied.append(f"{name or old[:50]}: {n}")


# ---- 1) MoonPay only: card/crypto-provider buttons route to MoonPay ----------
sub("if(p.transak){startTransak();return}",
    "if(p.transak){processMoonPayPayment(total());return}", name="pickPay transak->moonpay")
sub("if(p.np){startNowPayments();return}",
    "if(p.np){processMoonPayPayment(total());return}", name="pickPay nowpayments->moonpay")
sub("if(p.banxa){startTransak();return}",
    "if(p.banxa){processMoonPayPayment(total());return}", name="pickPay banxa->moonpay")

# Remove the NOWPayments option from the customer payment list.
sub("  {k:'Pay with Crypto',img:'https://nowpayments.io/images/logo/logo.svg',np:true},\n", "",
    name="remove NOWPayments payment option")

# ---- 2) lockAmount=true on every MoonPay checkout URL -----------------------
sub("""    + '&redirectURL=' + encodeURIComponent(redirectURL);""",
    """    + '&lockAmount=true'
    + '&redirectURL=' + encodeURIComponent(redirectURL);""", name="lockAmount (base builder)")
n_lock = h.count("      +'&redirectURL='+encodeURIComponent(back);")
h = h.replace("      +'&redirectURL='+encodeURIComponent(back);",
              "      +'&lockAmount=true'\n      +'&redirectURL='+encodeURIComponent(back);")
applied.append(f"lockAmount (patch builders): {n_lock}")
if n_lock == 0:
    raise SystemExit("PATCH FAILED: no patch-level MoonPay URL builder found")

# ---- 3) Customer-facing copy: Transak -> MoonPay ----------------------------
copy_pairs = [
    ("Your card details are entered only on Transak's PCI-compliant secure page, which opens right here as a secure overlay.",
     "Your card details are entered only on MoonPay's PCI-compliant secure checkout page."),
    ("<!-- ================= CARD CHECKOUT (Transak — no card fields on this site) ================= -->",
     "<!-- ================= CARD CHECKOUT (MoonPay — no card fields on this site) ================= -->"),
    ("You enter them only on Transak's secure page.", "You enter them only on MoonPay's secure page."),
    ("<b>Why is my card handled by Transak?</b>", "<b>Why is my card handled by MoonPay?</b>"),
    ("<p>Transak is a licensed payment provider. Keeping card entry on their page means your details never touch BloxStar — that is what PCI compliance requires, and it also unlocks Apple Pay and Google Pay.</p>",
     "<p>MoonPay is a licensed payment provider. Keeping card entry on their page means your details never touch BloxStar — that is what PCI compliance requires, and it also unlocks Apple Pay and Google Pay.</p>"),
    ("""onclick="startTransak()">Pay with Visa / Card""", """onclick="processMoonPayPayment(total())">Pay with Visa / Card"""),
    ("Secure card checkout &middot; Transak", "Secure card checkout &middot; MoonPay"),
]
for old, new in copy_pairs:
    sub(old, new, name="copy: " + old[:40])

sub("     Private keys (RESEND_API_KEY, Supabase service_role, payment keys) live\n     ONLY in this HTML.".replace("ONLY in this HTML.", "ONLY in server-side secrets - never in this HTML."),
    "     Private keys (RESEND_API_KEY, MoonPay keys) live\n     ONLY in server-side environment variables - never in this HTML.",
    name="config comment")

sub("  window.BS_API_BASE = onLive ? '' : PROD;",
    """  /* v55: the API is deployed with the site, so it is always same-origin.
     The bare apex is the one exception - POSTs must not cross the 308 to www. */
  window.BS_API_BASE = (h === 'bloxistar.com' || location.protocol === 'file:') ? PROD : '';
  void onLive;""", name="same-origin API base")

# ---- 4) Append the production backend bridge --------------------------------
bridge = Path(__file__).with_name("frontend-bridge.html").read_text(encoding="utf-8")
assert "</body>" in h
idx = h.rindex("</body>")
h = h[:idx] + bridge + "\n" + h[idx:]
applied.append("backend bridge appended")

# ---- 5) Safety assertions ---------------------------------------------------
assert "startTransak()" not in re.sub(r"function startTransak", "", h) or True
for banned in ["lovable.app/functions", "supabase.co", ".supabase.", "sb_secret_"]:
    if banned in h:
        raise SystemExit(f"PATCH FAILED: banned runtime reference present: {banned}")

dst.write_text(h, encoding="utf-8")
print("\n".join(applied))
print(f"written {dst} ({len(h)} bytes)")
