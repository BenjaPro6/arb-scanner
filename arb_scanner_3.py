import requests
import time
import os
from datetime import datetime

# ── Configuración ──────────────────────────────────────────────
ODDS_API_KEY    = "TU_API_KEY_ACA"
TELEGRAM_TOKEN  = "8386508769:AAHkaxPXxEpRrv3IJc-qUZ6621PDr3E8PwY"
TELEGRAM_CHAT_ID = "7074312345"

REFRESH_SECONDS     = 60       # cada cuánto escanea
MIN_PROFIT_PERCENT  = 0.3      # ganancia mínima bruta para mostrar
EXCHANGE_COMMISSION = 5.0      # % comisión en exchanges (Betfair, Matchbook)
STAKE               = 100      # stake total en $
TOP_N               = 10       # cuántas oportunidades mandar por Telegram

# ── Casas habilitadas (whitelist) ──────────────────────────────
TRUSTED_BOOKS = {
    "betfair": "Betfair",
    "pinnacle": "Pinnacle",
    "bet365": "bet365",
    "williamhill": "William Hill",
    "unibet": "Unibet",
    "draftkings": "DraftKings",
    "fanduel": "FanDuel",
    "betway": "Betway",
    "bwin": "bwin",
    "ladbrokes": "Ladbrokes",
    "coral": "Coral",
    "paddypower": "Paddy Power",
    "skybet": "Sky Bet",
    "888sport": "888sport",
    "matchbook": "Matchbook",
    "betsson": "Betsson",
    "nordicbet": "NordicBet",
    "codere": "Codere",
    "1xbet": "1xBet",
    "leovegas": "LeoVegas",
}

EXCHANGE_KEYS = {"betfair", "matchbook"}

BOOK_URLS = {
    "betfair": "https://www.betfair.com",
    "pinnacle": "https://www.pinnacle.com",
    "bet365": "https://www.bet365.com",
    "williamhill": "https://www.williamhill.com",
    "unibet": "https://www.unibet.com",
    "draftkings": "https://www.draftkings.com",
    "fanduel": "https://www.fanduel.com",
    "betway": "https://www.betway.com",
    "bwin": "https://www.bwin.com",
    "ladbrokes": "https://www.ladbrokes.com",
    "coral": "https://www.coral.co.uk",
    "paddypower": "https://www.paddypower.com",
    "skybet": "https://www.skybet.com",
    "888sport": "https://www.888sport.com",
    "matchbook": "https://www.matchbook.com",
    "betsson": "https://www.betsson.com",
    "nordicbet": "https://www.nordicbet.com",
    "codere": "https://www.codere.com",
    "1xbet": "https://www.1xbet.com",
    "leovegas": "https://www.leovegas.com",
}

# ── Funciones de cálculo ───────────────────────────────────────
def effective_odd(odd, book_key):
    if book_key in EXCHANGE_KEYS:
        return 1 + (odd - 1) * (1 - EXCHANGE_COMMISSION / 100)
    return odd

def calc_arb(odds):
    implied = sum(1 / o["odd"] for o in odds)
    return implied, implied < 1, ((1 / implied) - 1) * 100

def calc_arb_net(odds):
    implied = sum(1 / o["eff_odd"] for o in odds)
    return implied, implied < 1, ((1 / implied) - 1) * 100

def calc_stakes(odds):
    implied = sum(1 / o["eff_odd"] for o in odds)
    return [o | {"stake": STAKE * (1 / o["eff_odd"]) / implied} for o in odds]

# ── API ────────────────────────────────────────────────────────
def get_active_sports():
    url = f"https://api.the-odds-api.com/v4/sports/?apiKey={ODDS_API_KEY}&all=false"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    return [s for s in r.json() if s.get("active") and not s.get("has_outrights")]

def get_odds(sport_key):
    url = (
        f"https://api.the-odds-api.com/v4/sports/{sport_key}/odds/"
        f"?apiKey={ODDS_API_KEY}&regions=eu,uk,us,au&markets=h2h&oddsFormat=decimal"
    )
    r = requests.get(url, timeout=10)
    if r.status_code == 422:
        return []
    r.raise_for_status()
    remaining = r.headers.get("x-requests-remaining", "?")
    print(f"  [{sport_key}] {len(r.json())} partidos · requests restantes: {remaining}")
    return r.json()

# ── Procesamiento ──────────────────────────────────────────────
def process_games(games, sport_title):
    results = []
    for game in games:
        books = [b for b in game.get("bookmakers", []) if b["key"] in TRUSTED_BOOKS]
        if not books:
            continue

        best = {}
        for book in books:
            market = next((m for m in book["markets"] if m["key"] == "h2h"), None)
            if not market:
                continue
            for outcome in market["outcomes"]:
                name = outcome["name"]
                eff = effective_odd(outcome["price"], book["key"])
                if name not in best or eff > best[name]["eff_odd"]:
                    best[name] = {
                        "outcome": name,
                        "odd": outcome["price"],
                        "eff_odd": eff,
                        "book": TRUSTED_BOOKS[book["key"]],
                        "book_key": book["key"],
                        "is_exchange": book["key"] in EXCHANGE_KEYS,
                    }

        odds_arr = list(best.values())
        if len(odds_arr) < 2:
            continue

        gross_implied, gross_is_arb, gross_profit = calc_arb(odds_arr)
        net_implied, net_is_arb, net_profit = calc_arb_net(odds_arr)

        if not gross_is_arb:
            continue
        if gross_profit < MIN_PROFIT_PERCENT:
            continue

        stakes = calc_stakes(odds_arr)
        results.append({
            "id": game["id"],
            "home": game["home_team"],
            "away": game["away_team"],
            "sport": sport_title,
            "time": game["commence_time"],
            "book_count": len(books),
            "gross_profit": gross_profit,
            "gross_implied": gross_implied,
            "net_profit": net_profit,
            "net_implied": net_implied,
            "net_is_arb": net_is_arb,
            "stakes": stakes,
        })
    return results

# ── Telegram ───────────────────────────────────────────────────
def send_telegram(message):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    r = requests.post(url, json=payload, timeout=10)
    return r.ok

def build_message(opportunities):
    top = sorted(opportunities, key=lambda x: x["net_profit"], reverse=True)[:TOP_N]
    now = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    msg = f"🎯 <b>ARB SCANNER — {len(top)} oportunidad{'es' if len(top) > 1 else ''}</b>\n"
    msg += f"🕐 {now}\n\n"

    for i, p in enumerate(top):
        dt = datetime.fromisoformat(p["time"].replace("Z", "+00:00"))
        date_str = dt.strftime("%d/%m %H:%M")
        gross_gain = STAKE / p["gross_implied"] - STAKE
        net_gain   = STAKE / p["net_implied"]   - STAKE

        msg += "━━━━━━━━━━━━━━━\n"
        msg += f"{i+1}. <b>{p['home']} vs {p['away']}</b>\n"
        msg += f"🏆 {p['sport']} · {date_str}\n"
        msg += f"📊 Sin comisiones: <b>+{p['gross_profit']:.2f}% (+${gross_gain:.2f})</b>\n"
        msg += f"💰 Neto real: <b>{'+'if p['net_is_arb'] else ''}{p['net_profit']:.2f}% ({'+'if net_gain>=0 else ''}${net_gain:.2f})</b>\n\n"
        msg += f"📋 <b>Instrucciones (stake ${STAKE}):</b>\n"

        for s in p["stakes"]:
            url = BOOK_URLS.get(s["book_key"], "#")
            exch = " (exchange)" if s["is_exchange"] else ""
            msg += f"• <b>{s['outcome']}</b> → ${s['stake']:.2f} @ {s['odd']:.2f} en <a href='{url}'>{s['book']}</a>{exch}\n"
        msg += "\n"

    msg += "━━━━━━━━━━━━━━━\n"
    msg += "⚠️ Verificá los odds antes de apostar. Las ventanas duran minutos."
    return msg

# ── Loop principal ─────────────────────────────────────────────
def main():
    print("🚀 ARB SCANNER iniciado")
    print(f"   Refresh: cada {REFRESH_SECONDS}s · Stake: ${STAKE} · Min profit: {MIN_PROFIT_PERCENT}%\n")

    sent_ids = set()

    while True:
        print(f"\n🔍 Escaneando... {datetime.now().strftime('%H:%M:%S')}")
        try:
            sports = get_active_sports()
            print(f"   {len(sports)} deportes activos")

            all_results = []
            for sport in sports:
                try:
                    games = get_odds(sport["key"])
                    results = process_games(games, sport["title"])
                    all_results.extend(results)
                except Exception as e:
                    print(f"   Error en {sport['key']}: {e}")

            arbs_net = [r for r in all_results if r["net_is_arb"]]
            new_arbs = [r for r in arbs_net if r["id"] not in sent_ids]

            print(f"   Arbs brutos: {len(all_results)} · Netos: {len(arbs_net)} · Nuevos: {len(new_arbs)}")

            if new_arbs:
                msg = build_message(new_arbs)
                ok = send_telegram(msg)
                if ok:
                    print(f"   ✅ Telegram enviado ({len(new_arbs[:TOP_N])} oportunidades)")
                    for r in new_arbs:
                        sent_ids.add(r["id"])
                else:
                    print("   ❌ Error enviando Telegram")
            else:
                print("   Sin nuevas oportunidades netas")

        except Exception as e:
            print(f"   ❌ Error general: {e}")

        print(f"   Esperando {REFRESH_SECONDS}s...")
        time.sleep(REFRESH_SECONDS)

if __name__ == "__main__":
    main()
