# First looks at the MemeLens UI through the proven pixel route (13 Nov 2026)

Written BEFORE any number was checked against it. The route was proven first: sealed test S59A matched 6/6 at 09:58Z
(`eyes gate` PROVEN). Pictures: preview build of b8e133d + the wallet CSS fix, served on 127.0.0.1:8731, drawn by the `see`
tool. SEEN = my eye on a picture. Colours, sizes and exact words are NOT from my eye: they come from the measuring tools
(layout, inspect_page, scripts/audit-states.mjs).

## What I saw

**Feed at 1366x728** (an OVERVIEW shrunk to 955x509, so small text was only roughly readable)
- A narrow left rail with three items; the open one (Feed) has a filled, tinted background and a bar on its left edge.
- A table of five tokens. The selected row (SYN5) has a tinted background and a bar on its left edge. Numbers sit in
  right-aligned columns. The Token column has a bold name over a small grey address.
- In the Risk column the one red "Critical 93" pill pulls the eye harder than anything else in the table. The other four
  rows have a dashed "Unknown" pill and a grey "17% of signals known" line.
- A detail panel on the right (about 40% of the width): big "SYN5" title, a grey sentence of facts, a ring gauge with "93",
  a bar of orange and dashed segments, and a table of signals. The facts sentence ("Created ... creator ... mint authority
  yes ... freeze authority no") is one long run of small grey text and is hard to scan.
- Below the five rows the table area is empty. That is only because the sample has five tokens.

**Backtest at 1366x728** (overview shrunk to 1120x597)
- The picture shows only the TOP of the screen: an engine card ("Engine 0.1.2 is installed - idle", a Check for update
  button), then a bordered group with a textarea, a four-way period choice with "30 days" chosen, and a grid of fields.
  **I did NOT see the backtest RESULT.** It is below the first screen; the name I gave this picture is wrong.
- The "Backtest" page title has a visible rounded outline around it (it looks like a focus ring on the heading).
- The content stops at about three quarters of the window width; the right quarter is empty.

**Wallet at 900x600** (native size, no shrinking)
- The "Wallet" title has the same rounded outline around it. A "<- Smart money" button sits to its left.
- The data notice wraps to two lines: the chain line, then the yellow SYNTHETIC DATA label under it. Together with the
  title bar this takes a fifth of the window height before any content starts.
- The wallet's own name ("alice") is small, grey and monospace: it is the weakest text on the screen, weaker than the
  three stat cards (REALISED / UNREALISED / SELLS WITH NO KNOWN BUY), whose values are the largest text.
- The positions table fits inside its panel with no sideways scroll. The long header "SOLD WITHOUT A KNOWN BUY" wraps to two
  lines (that is the fix made this session). Only about three table rows are visible at this height.

## What I did not see
The Backtest result, the Smart money screen, the first-run screen, anything in forced-colors, motion, or any real Windows
rendering. Nothing above says the design is "premium": it says where the hierarchy is weak and where space is spent.

## Second look: Backtest at 1366x1000 (written before checking where the result is)

Overview shrunk to 901x660. I saw the engine card at the top and the bordered form group filling the rest of the picture, in
a grid of four or five rows of fields, down to the bottom edge. I did not see a result block, a table of positions or a
totals strip anywhere in it. So the picture does not show a result either, even on a taller window. I cannot say from the
picture whether the run has finished, failed, or not started.

## Checked against numbers (scripts/probe-page.mjs, real Chromium, 13 Nov 2026)

| # | What I said from the picture | Measured | Verdict |
|---|---|---|---|
| 1 | Feed: detail panel about 40% of the width | grid `788px 500px`; 500 / 1366 = 36.6% | close |
| 2 | Feed: the four unmarked rows say "17% of signals known" | 3 say 17%, one (SYN1) says 45% | wrong in detail |
| 3 | Feed: the one red "critical 93" pill pulls the eye | only the SYN5 row has a red badge (rgb 255,77,115) and a flag; the rest is grey | consistent |
| 4 | Feed: the facts sentence is small grey text | 14px, the same size as body text; grey rgb(141,154,174) | "small" wrong, grey right |
| 5 | Feed: bold name over small grey address | name 14px/650 in the accent colour; address 12px/500 grey | right |
| 6 | (not seen) | the SYN5 row is 87px tall, the other four 66px: the extra line is its flag | new fact |
| 7 | Backtest: a rounded outline round the page title | scripted start: `:focus-visible` true, 2px solid rgb(139,155,255). Real mouse click on the rail: **no ring**. Keyboard Enter: ring | seen, but an artifact of the preview's scripted start; correct for keyboard users |
| 8 | Backtest: content stops at about three quarters of the width | `.bt` 980px wide from x=106: ends at 1086 of 1366 = 79.5%; 280px (20.5%) empty | "three quarters" wrong, about four fifths |
| 9 | Backtest: the result is not on the first screen | form 664px tall, result starts at y=943 in a scroll area 637px tall (908px at a 1000px window): 306px below the fold; code has no `scrollIntoView`, no focus move and no `role=status` on success | confirmed |
| 10 | Wallet: title bar and notice take a fifth of the height | 54 + 59 = 113px of 600 = 18.8% | right |
| 11 | Wallet: the notice wraps to two lines | notice 59px tall | consistent |
| 12 | Wallet: the wallet's own name is the weakest text | visible name 12px/400 grey mono; stat values 22px/700 | right |
| 13 | Wallet: the long header wraps to two lines | header row 55px against 39px on the feed | right |
| 14 | Wallet: about three rows visible | 5 rows of 63px; 2 fully visible, the third cut at 52 of 63px | roughly right |

Score: 14 claims, 9 right or close, 3 wrong in a detail (2, 4, 8), 1 seen but not a defect (7), 1 new fact (6). **The eye
is good for structure and for where the weight sits; it is not good for fractions, sizes and counts.** Those come from
numbers, always.

## What this adds up to (proposals as numbers, nothing built yet)
1. **A finished backtest is invisible.** The result starts 306px below the fold at 1366x728 and nothing brings it into
   view or announces it (success has no `role=status`; only failure speaks). Proposal, test first: after a successful run
   move focus to the result's heading (`tabIndex=-1`, like the screen headings) and scroll it into view; add a one-line
   `role=status` "Finished: N positions entered". Measure again: result top <= 637px after the run.
2. **The Backtest form is 664px tall**, which is what pushes the result away. Proposal: result beside the form at widths
   >= 1280 (980 + 280px free is room for one column of about 380px), or the result above the form once there is one.
3. **Row height.** Feed rows are 66px (87 with a flag), wallet rows 63px: nine feed rows fit in 637px. A 44px row would
   show 13. Density is a taste call; the numbers are here for it.
4. **Wallet at the 900x600 minimum:** 113px of chrome before content and two full rows. Proposal: the data notice becomes
   one line at that width (about 30px saved), the wallet's name gets a real title size (it is 12px grey now).
5. **Tooling lesson:** pictures from the preview's `?go=` start carry artifacts of its scripted navigation (the title
   ring). State that depends on how a person arrived is measured with real input (`--act click:` / `key:`), not read off
   a picture.

## What was done about it (13 Nov 2026, same day)
Each change started as a failing test, in the stylesheet contract (`style.test.ts`, red 2 of 41) and in the real Chromium
audit (`scripts/audit-states.mjs`, wallet 99/111 and Backtest 103/111 before; **120 combinations, 1122/1122 after**).

| # | Finding | Before | After | How measured |
|---|---|---|---|---|
| F1 | A finished backtest is invisible | result starts 306px below the fold, nothing moves focus | result heading is focused and scrolled into view (`785bc57`) | audit check red 12/12, green 12/12 |
| F2 | The Backtest is narrower than its screens | `.bt` 980px in a 1124px column; form 664px tall; result at y=943 | `.bt` 1124px (the shared 1180px measure less padding); form 549px; result at y=829; prose capped at 80ch (widest paragraph 641px at 1920x1040) | `.bt` box and form box, real Chromium |
| F4 | A wallet's own address is the weakest text | 12px/400 grey, 3 stat figures at 22px | 18px/600 in the text colour (rgb 227,233,243), mono; a 44-character address stays on one line (751px wide, 27px tall); the figures are still larger (22px) | computed style and box |
| F3 | Row density (66px rows, 87 with a flag, nine rows in 637px) | - | **not built**: a taste call for the Founder | numbers only |

What the numbers corrected in my own proposals above:
- **Proposal 2 is only half done.** The form is 115px shorter (664 to 549) but the result is still below the fold at
  1366x728 (y=829 against a 637px scroller). It is now found by focus, not by luck. A result beside the form would need a
  layout decision; not built.
- **Proposal 4, the notice line, is not a defect in real data.** The notice is 59px tall only with the yellow SYNTHETIC
  pill (demo data); without the pill it is 33px, one line. Nothing to fix.
- **A probe of mine measured the wrong thing.** It reported "3 columns" for the Backtest parameter grid. The picture
  showed four fields in the first row and three in the second; the numbers agree (x = 125, 402, 679, 956, then 125, 402,
  679). The probe had matched the first fieldset, not the parameter one. The eye was right and the script was wrong.

### Looking at the result (sandbox route, integrity OK both times)
Two pictures, each read and written down *before* any number was looked at
(`2026-11-13-after-f2-f4-reading-wallet.txt`, `...-backtest.txt`). Wallet 900x600: the title reads as a title, near
white, mono, larger than the grey line under it and smaller than the cards' figures (18px against 22px; the "Wallet"
heading is also 18px). Backtest 1366x728: content ends at about x=1230 (106+1124), four fields then three, help text
wraps to two lines on three fields (delay, take profit, stop loss; confirmed 2, 2, 2 lines), and the Run button is below
the fold (y=775 in a 728px window), which the picture could not show and the number did. Every claim in the two readings that I
checked held (title colour and size ordering, the 18/22px relation, the notice on two lines, 4+3 fields, the two-line
help text, the right edge, the hidden Run button). The only disagreement was between the picture and my own earlier
script, and the numbers sided with the picture. Not checked by number: that the textarea spans the full width.

## Third look: the installed app on Windows (run 43423985212, 13 Nov 2026, same day)
First pictures of the real Windows build: the installed app, driven by the live-engine CI run, 1008x655 pictures saved by its own checks.
The eyes channel was proven again before I read them: sealed test P59B at 12:55Z, six characters read off a decoded picture, MATCH 6/6.
(The `read_file` result is only the text line "Image: PATH (N bytes)" whether or not a picture arrives; that line is not evidence. At 12:3x I
wrongly marked one of these readings as "not a look" because of that line, then corrected it after the sealed test.)

Readings were written before any number (`2026-11-13-windows-wallet-reading.txt`, `...-backtest-result-reading.txt`) and checked on the PNGs:

| Claim in the reading | Number | Verdict |
|---|---|---|
| Wallet: the data notice is one line at this width | borders at y=53 and 90: 37px | right |
| Wallet: table rows about 43px | rules at y=430, 473, 516, 559, 602: 43px | right (the pixel map had already listed two of them) |
| Wallet: title "alice" bold, larger than the grey line, smaller than the card figures | title letters 13px tall, figure digits 15px tall | right |
| Backtest result: the list is narrower than the cards | list rules x=106..725 = 620px | right (card edge not measured) |
| Backtest result: the Exits value wraps to two lines | that row is 58px, the others 38.5px | right |
| Backtest result: the red figure reads well | rgb(255,122,134) on rgb(17,21,28) = 7.30:1 | right |
| **Backtest result: the Result heading's focus ring has no top edge** | **no horizontal ring row at the top of the scroll area; the 2px bottom edge at y=117-118; sides start at y=91** | **right, and a real defect** |

**The defect, and why my own check missed it.** After a run, `scrollIntoView({block:"start"})` puts the Result heading flush with the top of
its scroll area. Its focus ring reaches 4px outside the box (2px outline + 2px offset), so the top 4px of the ring were clipped. The F1 audit
check I wrote this morning asked "is the heading focused, and is its top >= 0?" - against the window, not against the scroll area, which
starts at y=91 under the title bar and notice. It could not fail. Now it measures the heading and its ring against the scroll area.

A second slip, caught the same hour: after I ran a plain `npm run build -w apps/desktop` to check the README, the audit's preview folder
(`apps/desktop/dist/preview`) was gone, and the red run failed all 12 combinations with "no <main> content within 20 s". That is a red for the
wrong reason (a 404, not the focus ring), so I rebuilt the preview and ran it again before changing any CSS.

| | Before | After |
|---|---|---|
| Room above the Result heading in its scroll area | 0px (heading top 91 = area top 91 at 1366x728; 113 = 113 at 900x600) | 12px (heading top 103, area top 91) |
| Stylesheet contract (`style.test.ts`) | red 1 of 42 ("expected undefined to be defined") | 42 of 42 |
| Real Chromium, finished backtest, 12 combinations | the new ring check failed in every combination shown (8 of 8 lines kept) | 135 of 135 checks |
| Full audit | 120 combinations, 1122 of 1122 (the old check could not see this) | 120 combinations, 1134 of 1134 |
| Full suite | 1694 passed, 26 skipped | 1695 passed, 26 skipped; `tsc` clean |

Fix: `.bt-result h2 { scroll-margin-top: 12px; }` (scrollIntoView honours it). Seen again on Windows below.

### After the fix, on Windows (live-engine run 43430616601, commit 502d9f8, both jobs green)
Run numbers (from its log): Windows unit tests 1694 passed, 27 skipped; smoke 26/26; first-run checks 9/9; installed-app checks 38/38 (the update
check finds engine 0.1.2, it installs from the release host into `%LOCALAPPDATA%\MemeLens\sidecar`, a backtest on the app's own database enters 5
positions, the result names the engine); install and uninstall both exit 0; `MemeLens.exe` is gone afterwards; the engine is still there with the
SHA-256 its manifest names. The database's survival after uninstall is by design but is NOT checked by the run.
The picture (`5-backtest-result.png`, read before measuring, `2026-11-13-windows-backtest-result-after-fix-reading.txt`): the Result heading now has
a complete outline. Numbers: ring rows at y=99-100 (top) and 129-130 (bottom), 9px of page between the notice band and the ring's top.
One earlier claim of mine is refuted by this picture: the list rows are not striped, only the first row is shaded. Open, taste: the outline runs
across the whole content width around a short word.

