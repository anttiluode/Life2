# Life² — Bloodlines

**A family, through history. Love is still a flux.**

You live one life at a time, from 18 until it ends. Every year you have a few drops of attention to pour into the people around you, your work, yourself, a dream. Whatever you stop feeding withers by itself. That is the vine economy from [LifeSucks](https://github.com/anttiluode/LifeSucks) and [Elävä Matriisi](https://github.com/anttiluode/ElavaMatriisiClaude).

Around that life:

- **Real history arrives on its real dates.** The Antonine and Justinian plagues, the Black Death, the English Civil War, the Great Fire of London, the South Sea Bubble, the Finnish famine of 1866–68, America-fever, two world wars, the 1918 flu, the 1923 hyperinflation, the Winter War, the depression of the nineties, 2008, the pandemic. Each one is a fork: flee the plague or tend the sick, fight or pay or hide, sell everything for grain or endure, leave for America or stay.
- **A family fortune** that you invest across what exists in that century: cash, land, trade ventures, lending, and from around 1700 shares. It can grow for centuries or be wiped out in one year (1720, 1923, 1929, 1948). Class follows the money: poor, working, middling, wealthy, elite. Lifestyle grows with class, debt grows by itself, and before 1800 rich families leave most of the fortune to the eldest son.
- **Generations.** When you die you see the funeral, who came, what withered and who history took. Then you choose which child carries the line on. A child under 16 grows up off-screen first. The heir inherits their share, their siblings, their surviving parent, their own children, and how close you were. Migrations move the whole line to another country. When no child is left, the line ends.
- **Saving, loading, re-roll and going back.** Every dynasty autosaves in your browser. Load any saved dynasty, copy one, or **go back to any earlier year** and choose differently. Narration and pictures can each be re-rolled without changing what happened.
- **The book.** Every year's narration and every milestone picture, generation by generation. You can read it in the game or download it as one HTML file to share.

## Starts

Rome 150 · Florence 1325 · England 1590 · Finland 1845 · Germany 1890 · America 1900 · Finland 1990. Families can migrate to America in the eras when people really did.

## AI narration and pictures, all local

The rule that keeps it good: **the AI tells the life, it never decides it.** Each year the engine freezes a small fact sheet: who you are, where, the year's history, what happened, and every person with their relation and how strong the bond is. The narrator writes 2–4 sentences from that sheet only. If it names a person who isn't on the sheet, the text is thrown away and re-rolled. After two failures the game uses the written narration instead. Pictures are made only at milestones (a birth, a partner, a migration, coming home from war, the first quiet year, rising or falling, the funeral, a plague arriving), one per year at most. Everything is in one picture-book gouache style. Each person carries a fixed look card (hair, build, one detail, a seed) so they stay recognisable across decades, and the palette follows the warmth of the home.

| narrator | how |
|---|---|
| Written | built in, no AI |
| Ollama | a local model, e.g. `qwen2.5:7b` or `qwen2.5:3b` |
| Other local server | anything OpenAI-compatible: llama.cpp `llama-server`, LM Studio |
| In the browser | WebLLM over WebGPU, ~1 GB one-time download (experimental) |

| painter | how |
|---|---|
| None | no pictures |
| Local | `local/painter_server.py`: SDXL-Turbo (or SD-Turbo) on your GPU |

### Setup on a 12 GB card (RTX 3060)

```bash
# 1. the narrator
ollama pull qwen2.5:7b              # about 4.7 GB; qwen2.5:3b if you want both models resident
OLLAMA_ORIGINS=* ollama serve       # lets the page talk to Ollama

# 2. the painter
pip install torch diffusers transformers accelerate pillow
python local/painter_server.py                                 # SDXL-Turbo, port 7861, ~7 GB VRAM
python local/painter_server.py --model stabilityai/sd-turbo    # smaller, ~3 GB, if VRAM is tight

# 3. the game, served locally (avoids browser rules about https pages calling localhost)
python -m http.server 8000          # then open http://localhost:8000
```

**On Windows** the `VAR=value command` form doesn't exist. Ollama usually already runs in the tray, and when the game is opened from `http://localhost:8000` its default settings normally let the page in, so first just try **Test** in the game. If the test can't reach Ollama:

```bat
:: cmd.exe — quit Ollama from the tray icon first, then:
set OLLAMA_ORIGINS=*
ollama serve

:: or make it permanent, then restart the Ollama app from the Start menu:
setx OLLAMA_ORIGINS "*"
```

In PowerShell the one-off form is `$env:OLLAMA_ORIGINS="*"; ollama serve`.

In the game, open **AI**, choose Ollama and Local painter, and press **Test**. SDXL-Turbo plus a 7B model may not both fit in 12 GB at once. Ollama unloads idle models after a few minutes, but the comfortable pairing is either `qwen2.5:3b` with SDXL-Turbo, or `qwen2.5:7b` with SD-Turbo.

## How the numbers behave

`node sim/bots.js 20` plays 20 dynasties per start with two simulated players, then rebuilds 20 played dynasties from their action logs to check that saving and going back are exact:

| start | strategy | generations (median, max) | lifespan median | line ended within 400 years | class at the end (poor / working / middling / wealthy / elite) |
|---|---|---|---|---|---|
| Rome 150 | balanced | 3 (11) | 67 | 90% | 0/3/10/7/0 |
| Rome 150 | greedy | 2 (8) | 45 | 100% | 5/1/6/6/2 |
| Florence 1325 | balanced | 9 (12) | 68 | 75% | 0/4/12/3/1 |
| England 1590 | balanced | 7 (12) | 70 | 65% | 1/4/10/5/0 |
| Finland 1845 | balanced | 9 (10) | 87 | 30% | 1/4/5/9/1 |
| Germany 1890 | greedy | 3 (14) | 69 | 75% | 4/2/1/7/6 |
| Finland 1990 | greedy | 6 (12) | 79 | 75% | 3/0/1/3/13 |

"Balanced" pours a little into everyone and spreads the fortune. "Greedy" works 8 drops a year, keeps one drop for family, and gambles on ventures and shares. Greedy lines get richer and end sooner. In antiquity most lines die out within a few generations whatever you do.

## Honest notes

- **Tested here:** the engine with simulated players and the replay check, and the page end to end in a headless browser with a *mock* Ollama and the painter's `--mock` mode. That covers three generations, the event cards, saving, reload and continue, going back, the fortune sliders, the book, and phone width. **Not tested here:** real models, because this machine has no GPU. The server code is the standard diffusers path and the Ollama call is the standard `/api/chat`, but expect to fix small things on first contact with your setup.
- **History is simplified on purpose.** Short texts, real dates, rough severities, approximate currencies. Genocide and slavery are left out as playable events. They are history, but not something to turn into a dice roll.
- **The browser narrator (WebLLM) is experimental** and was not run here.
- **Balance comes only from simulated players.** Real players will find what the bots didn't.

## Files

- `index.html`, `style.css`, `app.js` — the page: vine, panels, saves, go back, book, AI settings
- `engine.js` — the dynasty engine (vine economy, history, money, heirs, the action log)
- `history.js` — places, eras, names, money, the timeline of events, professions, assets
- `ai.js` — narrator and painter backends, prompts, the fact guard, the cache
- `local/painter_server.py` — the local image server (`--mock` for testing without a GPU)
- `sim/bots.js` — simulated dynasties and the replay check; `sim/mock_ollama.py` — a stand-in narrator for tests
