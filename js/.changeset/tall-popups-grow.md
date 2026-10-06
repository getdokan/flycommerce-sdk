---
'@flycommerce/app-bridge': patch
---

Popovers, date pickers and menus that reach past the bottom of a page are no longer cut off inside the dashboard: the frame grows while one is open and shrinks back when it closes. A popup that flipped above its trigger on a short page, and ran off the top, moves back below it. Needs `@flycommerce/ui` with its embedded popup cap; selects in their default item-aligned mode and `Combobox` aren't covered yet.
