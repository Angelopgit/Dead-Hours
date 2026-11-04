# Style guide

How Dead Hours looks and talks. Check new screens and new strings against this before they ship.

## The idea

A small Ohio town after midnight, the night the dead got up. The one light still on is the sodium lamp on the corner. Everything the player reads should feel like it belongs to that night: hand-lettered signs, a note taped to a door, a radio reading out what it knows. Not a dashboard, and not a trailer.

## Voice

- Plain words, short sentences. Say what happened or what to do: "Board the windows." not "FORTIFY YOUR POSITION".
- Talk to the player as "you". No hype ("Epic!", "Unleash"), no exclamation marks except a single shout in the HUD ("Reloading" is not a shout).
- One thought per line. Don't chain phrases with middle dots ("THE SAFEHOUSE · 21:47 · GEAR UP"). Write a sentence: "The safehouse, 9:47 pm. Gear up before they come."
- Numbers are numbers: "3 left", "+40 health", "2.6 s".
- Times are on a 12-hour clock with am/pm, as people in Vesper would say them: "9:47 pm", "3:00 am".
- Name things the way a person in the town would: "the corner store", "Rudy's", "the van", not "Objective B".

## Case

- **Capitals** for the logo, screen titles (SETTINGS, ARMORY), menu items, key caps, and the HUD lines read at a glance mid-fight: a notice's first line, the timer, warnings, interaction prompts ("TAKE AMMUNITION, 3 LEFT") and the control strips shown when you get on a board, a bike or into a car.
- **Sentence case** for everything else: tags beside menu items, notice second lines, hints, descriptions, tips, results, settings labels, the goals card.
- A HUD line that holds two things separates them with a comma ("PRYING A BOARD OFF, 3/6"), or with a wide space in the timer, never a middle dot.
- Outside the HUD, don't type strings in capitals to make them capitals: write them in sentence case and let the class's `text-transform` decide, so the copy reads right in the code and in a screen reader.

## Type

| Use | Face | Notes |
| --- | --- | --- |
| Logo, titles, menu items, HUD numbers | Big Shoulders Display 700/800 | Tight: letter spacing 0.01 to 0.08 em. Never wider. |
| Body, labels, hints, descriptions | Barlow Semi Condensed 400/500/600 | Normal spacing. |
| The tagline, loading tips, notes taped to things | Special Elite | Sparingly: one typewritten line per screen at most. |

Canvas signs in the world (house numbers, the store sign, crate stencils) use Big Shoulders Display too, so the town and the menus are one set of letters.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--fg` | `#e4ddd0` | Text, the selected option in a segmented control |
| `--fg-dim` | `#9a9387` | Secondary text |
| `--fg-faint` | `#625d55` | Hints, disabled |
| `--accent` | `#e8913a` | Sodium-lamp orange: focus, the primary button, ticks, progress |
| `--danger` | `#c4372b` | Damage, the clock's hands in the logo, warnings |
| `--ok` | `#8aa36f` | Done, safe |

Panels are warm black card stock (`--panel`) with a fine grain (`--grain`) and an orange top rule. No frosted glass, no rounded corners, no glow on text.

## Controls

- Checkboxes are square boxes with a tick, not phone switches.
- Segmented choices are a row of stamped boxes; the chosen one is filled with `--fg`.
- One primary button per panel, filled orange. Others are outlined.

## Names

The town is **Vesper, Ohio**. Streets: **Hale Street** (the safehouse street), **Pell Lane**, **Kinney Street**. The corner store is **Rudy's**. The house across from the safehouse is **the Mercer house**. The serum in rare drops is **Halberg serum**. Code identifiers (`MAPLE_HOLLOW`, `oak-street.ts` and so on) keep their old names; only what the player sees changed.

## Writing a new string: checklist

1. Would a person say it out loud like that?
2. Sentence case unless it is a title, a menu item or a HUD headline?
3. No middle dots, no exclamation marks, no "epic"?
4. Does it say what to do next, when the player needs to do something?
