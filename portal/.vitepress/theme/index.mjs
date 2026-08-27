// The default VitePress theme, wearing the palette the rest of the site wears.
//
// ADR-0005 §6 asks for one visual language across the four surfaces. The
// documentation is the one of them that is not ours to lay out — it is a
// generated site with its own theme — so the whole of the customisation is a
// stylesheet that maps that theme's own variables onto our tokens. No component
// is overridden and no layout is replaced: the next VitePress upgrade has one
// file to disagree with rather than a fork of a theme.

import DefaultTheme from "vitepress/theme";
import "./coinslot.css";

export default DefaultTheme;
