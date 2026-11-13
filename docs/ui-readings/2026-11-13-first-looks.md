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
