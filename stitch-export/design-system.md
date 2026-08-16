---
name: LedgerBase Visual Identity
colors:
  surface: '#f7f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f7f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#45464d'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#76777d'
  outline-variant: '#c6c6cd'
  surface-tint: '#565e74'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#131b2e'
  on-primary-container: '#7c839b'
  inverse-primary: '#bec6e0'
  secondary: '#515f74'
  on-secondary: '#ffffff'
  secondary-container: '#d5e3fd'
  on-secondary-container: '#57657b'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#001e2f'
  on-tertiary-container: '#008cc7'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#d5e3fd'
  secondary-fixed-dim: '#b9c7e0'
  on-secondary-fixed: '#0d1c2f'
  on-secondary-fixed-variant: '#3a485c'
  tertiary-fixed: '#c9e6ff'
  tertiary-fixed-dim: '#89ceff'
  on-tertiary-fixed: '#001e2f'
  on-tertiary-fixed-variant: '#004c6e'
  background: '#f7f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  display:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  data-tabular:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-code:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  stack-xs: 0.25rem
  stack-sm: 0.5rem
  stack-md: 1rem
  stack-lg: 1.5rem
  inset-table: 0.75rem 1rem
  container-max: 1440px
  gutter: 1rem
---

## Brand & Style

The design system is engineered for high-stakes financial environments where accuracy and auditability are paramount. The aesthetic is **Corporate / Modern**, leaning into a "Precision Enterprise" style characterized by high data density, rigorous alignment, and a sober, trustworthy atmosphere.

The visual narrative avoids unnecessary decoration, focusing instead on clarity and the relationship between complex data sets. It draws inspiration from modern fintech leaders, utilizing ample white space within structured containers to ensure that even the most information-dense ledger remains legible and navigable. The emotional response is one of absolute stability, immutability, and professional control.

## Colors

This design system utilizes a sophisticated, high-contrast palette rooted in deep navy and slate tones.

- **Primary (Trust Blue):** Used for navigation, primary actions, and branding to establish authority.
- **Secondary (Slate):** Applied to secondary actions and structural elements like borders and icons.
- **Surface Palette:** The background uses a very light cool-gray (`#F8FAFC`) to reduce eye strain during prolonged data entry, while the primary workspace containers are pure white (`#FFFFFF`) to pop against the background.
- **Financial Semantics:** Color is used functionally. **Emerald** represents credits, balanced states, and successful reconciliations. **Rose** is reserved for debits, overdrafts, and critical errors. **Amber** signifies pending transactions or items requiring manual review.

## Typography

The typography system prioritizes legibility and vertical alignment. **Inter** is the primary typeface, selected for its neutral, highly readable glyphs.

- **Tabular Figures:** For all financial amounts, the `tnum` (tabular numbers) OpenType feature must be enabled to ensure decimals align perfectly in vertical columns.
- **Hierarchy:** We use a strict hierarchy where headlines are bold and condensed in tracking to feel "locked-in."
- **Data Labels:** Small, uppercase labels with slightly increased tracking are used for metadata and table headers to distinguish them from user-generated data.
- **Monospace:** **JetBrains Mono** is utilized for transaction IDs, hash values, and audit logs to facilitate character-by-character comparison.

## Layout & Spacing

The layout utilizes a **Fixed Grid** system for dashboard views and a **Fluid Content Area** for large-scale ledgers.

- **Grid:** A 12-column system with 16px (1rem) gutters.
- **Density:** The spacing rhythm is "Tight-Functional." Row heights in tables are kept to a 40px minimum to maximize data visibility while maintaining touch-target accessibility.
- **Multi-tenancy Navigation:** A persistent sidebar (240px width) houses the organizational switcher. This sidebar uses a tiered indentation system to represent the hierarchy of Organization > Company > Branch.
- **Breakpoints:**
  - Mobile (<640px): Single column, full-width cards.
  - Tablet (640px - 1024px): Collapsed sidebar (icons only).
  - Desktop (>1024px): Full expanded sidebar and multi-pane ledger views.

## Elevation & Depth

This design system uses **Tonal Layers** and **Low-contrast Outlines** rather than heavy shadows to maintain a clean, professional "software" feel.

- **Level 0 (Background):** Slate-50 (#F8FAFC).
- **Level 1 (Cards/Containers):** Pure white background with a 1px solid border in Slate-200. This is the primary surface for all data tables.
- **Level 2 (Modals/Popovers):** Pure white with a very subtle, diffused shadow (0px 4px 12px rgba(15, 23, 42, 0.08)) and a Slate-300 border.
- **Depth Cues:** Active states for navigation or selected rows use a subtle left-hand border accent (4px) in the Primary Trust Blue or a very light blue tint (#F1F5F9) background.

## Shapes

The shape language is **Soft (0.25rem)**, conveying modern precision without feeling clinical or sharp.

- **Base Radius:** 4px (0.25rem) for buttons, input fields, and small UI components.
- **Large Radius:** 8px (0.5rem) for main dashboard cards and containers.
- **Pills:** Only used for status badges (e.g., "Reconciled," "Flagged") to distinguish them from actionable buttons or data containers.

## Components

- **Data Tables:** The core component. Headers are sticky, utilizing a light gray background (#F1F5F9). Rows feature a subtle hover state (#F8FAFC). Text alignment: Amounts are always right-aligned; text/IDs are left-aligned.
- **Buttons:**
  - *Primary:* Solid Trust Blue (#0F172A) with white text.
  - *Secondary:* White background with Slate-200 border and Slate-700 text.
- **Status Badges:** Subtle background tints with high-contrast text. Example: "Balanced" uses a light green background with dark green text.
- **Financial Amounts:**
  - *Positive:* Displayed as `$1,200.00` or `+$1,200.00` in Emerald-600.
  - *Negative:* Displayed as `($1,200.00)` or `-$1,200.00` in Rose-600.
- **Input Fields:** 1px Slate-200 border, turning to Primary Blue on focus. Labels are always visible above the field (never floating).
- **Audit Trail:** A specialized list component using Monospace font for timestamps and user IDs, connected by a vertical "track" line to show sequence.
- **Switcher:** A prominent dropdown at the top of the sidebar, clearly displaying the current entity's logo and name, with a search-indexed menu for rapid switching between branches.
