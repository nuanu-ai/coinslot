// The default VitePress theme, wearing the palette the rest of the site wears.
//
// The web surface decision asks for one visual language across the four
// surfaces. The documentation is the one of them that is not ours to lay out —
// it is a generated site with its own theme — so almost the whole of the
// customisation is a stylesheet that maps that theme's own variables onto our
// tokens. No component is overridden and no layout is replaced: the next
// VitePress upgrade has one file to disagree with rather than a fork of a
// theme.
//
// The one exception is the link below, and it is here because the theme cannot
// express it. The documentation is mounted at /docs on an origin it shares with
// the landing, the cabinet and the gateway, and every internal link VitePress
// writes is resolved against that mount point — so the site title in the corner,
// which normally takes a reader home, takes them to the front page of the
// documentation they are already in. There was no way out at all: a reader who
// arrived from the landing could go back, and a reader who arrived from a search
// result could not. A plain anchor is not resolved against anything and
// therefore goes where it says.
//
// It rides in `nav-bar-content-before` rather than in the corner, and that is
// the theme's shape rather than a preference. The slots at the corner render
// *inside* the title's own anchor, so a link put there is a link inside a link:
// invalid, and in practice the outer one takes the click and carries the reader
// to the page they are already on. It looked right and did nothing, which is
// how it shipped. This slot is outside that anchor.

import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "./coinslot.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "nav-bar-content-before": () =>
        h(
          "a",
          {
            class: "way-out",
            href: "/",
            // The one attribute that makes this leave the documentation at all.
            // VitePress runs a router over every same-origin link and handles
            // the click itself, and its router knows only the pages under
            // /docs — so a link to the site root was intercepted and went
            // nowhere, silently. A target makes its handler stand aside and the
            // browser follow the link, which is what a link is for. `_self`
            // rather than `_blank`: leaving the documentation is going back,
            // not opening something new.
            target: "_self",
            // Not `aria-label`: the text is already the label, and a second one
            // saying something longer is what a screen reader reads instead of
            // what everybody else sees.
            title: "The Coinslot site",
          },
          "← Coinslot",
        ),
    });
  },
};
