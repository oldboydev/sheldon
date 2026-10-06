# Sheldon web — interface system

Confirmed 2026-10-06. Apply on every `apps/web` UI change. Product copy is pt-BR.

## Direction and feel

Local loopback bench for a knowledge vault: operational, dense, trustworthy. Sentence case.
Buttons in infinitive. No marketing voice. No milestone leak (`M7`). One primary action per
screen (magenta). The person is at the machine that holds the vault; five minutes ago they
ingested or compiled; next they approve or capture another source.

**Domain:** vault, raw, proposta, conceito, revisão, loopback.

**Color world:** ink `#1b1b1c`, paper `#f7f7f9`, navy file `#001663`, magenta action `#e74092`,
status green/red as consequence.

**Signature:** provenance rail `raw → proposta → conceito` (last step magenta). Repeat in the
Início header, wiki aside, and review confirmation.

### Rejected defaults

- Charcoal sidebar + gold “S” disc → navy titlebar + text wordmark **Sheldon**
- Bahnschrift 63px on parchment `#e8e4da` → Nunito Sans 26px on `#f7f7f9`
- Stix equalizer / `stix` wordmark / `gradient-brand` identity → no logo mark at all
- Fake Electron window on navy wallpaper → full-viewport browser app

## Depth and spacing

- Depth: **subtle shadows** (`--shadow-card` on cards; `--shadow-pop` on popovers only).
  Borders `--line` / `--line-strong` for structure. Do not mix dramatic drop shadows.
- Spacing base **4px**. Scale: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40 (`--sp-*`).
- Titlebar **48px**. Sidebar **232px**. Content pad **24px**. Card pad **16–20px**.
- Radius: controls **8px**, cards **12px**, chips/pills **999px**, small **6px**.
- Sidebar uses the **same surface as the canvas** (`--card` / `--bg` split only by a 1px
  `--line`). Active nav: navy 8% fill + 3px magenta rail on the left.

## Hierarchy

- Type: **Nunito Sans** variable (already in `apps/cli/help/fonts/`). Mono **Consolas**.
  Fallback Segoe UI. Do not use Bahnschrift, Inter, or system-only UI.
- Ratio ~1.2 dense: `11 · 12 · 13 · 14 · 15 · 17 · 20 · 26`. Screen title **26px / 800**.
  Body **14px / 400 / 1.5**. Eyebrow **11px / 700 / 0.08em / uppercase / `--ink-faint`**.
- Weight + color do more than size. Four text levels: `--ink`, `--ink-soft`, `--ink-faint`,
  disabled opacity 0.45.
- Numbers: `tabular-nums`. Counts on buttons when they exist (“Aprovar (3)”).
- Focal pattern: **one 26px title + one magenta CTA**. Demote everything else.

## Tokens

Reuse the Stix token names already in `apps/cli/help/styles.css` and
`theme.css` of the design-system pack. Do not invent a second palette.

| Token                                     | Light                                 | Role                      |
| ----------------------------------------- | ------------------------------------- | ------------------------- |
| `--brand-navy`                            | `#001663`                             | titlebar, active nav text |
| `--brand-magenta`                         | `#e74092`                             | single primary action     |
| `--ink` / `--ink-soft` / `--ink-faint`    | `#1b1b1c` / `#636367` / `#8e8e93`     | text                      |
| `--bg` / `--bg-sunken` / `--card`         | `#f7f7f9` / `#efeff3` / `#fff`        | surfaces                  |
| `--line` / `--line-strong`                | `#e5e5ea` / `#c7c7cc`                 | borders                   |
| `--ok` / `--erro` / `--alerta` / `--info` | semantic pairs with `*-bg` / `*-line` | status                    |
| `--focus-ring`                            | double ring, `--brand-blue`           | AA focus                  |

Dark theme via `[data-theme="dark"]` (same token names, inverted values from the pack).
Do not key the default theme only on `prefers-color-scheme`. Honor
`prefers-reduced-motion`.

**Do not ship:** StixLogo, equalizer bars (`--eq-*` as chrome), `stix` wordmark,
`--gradient-brand` as product identity, PRD/QA env badges, window controls, avatar.

## Shell

```text
titlebar (navy, 48px)
  Sheldon | {vault path}     [neste computador]  Atualizar  tema
appbody
  sidebar 232px                content
    BANCADA                      crumbs
      Início                     26px title
      Fontes                     …
    VAULT
      Conhecimento
      Revisão (count)
      Consulta
    ENTREGA
      Bundles
    SISTEMA
      Configurações
    foot: green dot + somente neste computador
```

Nav labels stay the seven PRD 009 sections. Group headings are uppercase eyebrows.
Active item: `navitem.is-active`. Mobile ≤760px: sidebar becomes a horizontal scroller;
titlebar stays.

## Screens

- **Início** — title “Fila e saúde do vault.” Four tiles (fila, execução, atenção with
  `--erro` accent, vault). Left: atividade recente. Right: próximo passo + CTA **Nova fonte**.
- **Fontes** — one card, one CTA. Plugin preview is `banner--info`. OCR/STT/rede are chips.
- **Conhecimento** — three cards: tree · article · fontes/vizinhos. Existing API. Tree is
  the focal column (~260px).
- **Revisão** — pending list per topic (not two `<select>` as the only UI). Diff in a card.
  Primary **Aprovar** (magenta), **Rejeitar** (danger-soft). Confirmation shows the proposal
  id.
- **Consulta / Bundles / Configurações** — same field, button, table, and banner primitives.
  Bundle JSON only after preview.

## Component measurements

- Button primary — 38px h · 16px pad · 8px radius · 14px/700 · `--brand-magenta` · press
  `scale(0.992)` · hover `--brand-magenta-600`
- Button secondary — 38px h · 1px `--line-strong` · card fill
- Button sm — 30px h · 12px pad · 13px
- Icon button — 34px
- Input — 1px `--line-strong` · 8px radius · 10×12 pad · focus blue 3px mix
- Tile — 12px radius · 16px pad · 3px left accent optional · value 26px/800 tabular
- Badge/pill — 22–24px h · 999px radius
- Card — 12px radius · 1px `--line` · `--shadow-card`
- Motion — `--ease` cubic-bezier(.2,.7,.3,1) · `--dur-1` 120ms · `--dur-2` 200ms ·
  `--dur-3` 320ms. Primary press only; no enter animation on nav.

## Copy

- Language: pt-BR. Sentence case on titles and buttons.
- Infinitive on actions: “Nova fonte”, “Abrir revisão”, “Aprovar”, “Rejeitar”.
- Eyebrows: CAIXA ALTA + tracking.
- Status never color-only: icon/shape + label.
- No emoji. Outline SVG, `currentColor`.

## References

- Design pack: `C:\Users\paulo\Downloads\Design system and navigation specs` (`theme.css`,
  Ofertador target chrome in `screenshots/01-full.png`). Navigation pattern only; not the
  Stix logo in that screenshot.
- Tokens already in repo: `apps/cli/help/styles.css` + `apps/cli/help/fonts/`.
- Product IA: `docs/prds/009-local-web-interface.md`.
- Current app: `apps/web/src/App.tsx`, `styles.css`, `KnowledgeView.tsx`, `ReviewView.tsx`.
