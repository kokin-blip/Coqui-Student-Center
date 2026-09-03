# Coqui interface system

## Direction

Comfy is the primary, spacious daily workspace. Compact is a distinct weekly-calendar, work-table and inspector composition, not a spacing preset. Both Today compositions were visually approved on September 2, 2026; see `docs/design/ui-rebuild/` for references and comparison history. The primary identity is the approved transparent frog-face and lowercase wordmark artwork, never a substitute drawing or retyped lettering. Use locally bundled Inter for interface text. Never render the face below 20px or the wordmark below 112px wide. Native icon export replacement remains a separate certification item.

Fresh profiles start in Comfy/light; the first Compact selection defaults to dark. Each mode retains its independent theme, including System, and existing explicit themes and accents are preserved. Preferences remain device-local and are included in encrypted backups. Amber, coral, red, and blue are semantic colors, not decoration.

## Tokens

Components consume semantic OKLCH tokens for canvas, surface, text, border, accent, success, warning, danger, and information. Spacing follows a 4px base scale. Type, radius, shadow, z-index, motion, breakpoint, and density values are tokens. Visible transitions are 120–220ms and communicate a view or state change. Reduced motion removes translation and list choreography.

## Layout

- 1200px and above: labeled sidebar and fluid content.
- 768–1199px: icon rail with accessible labels.
- Below 768px: bottom navigation for Today, Calendar, Work, Study, and More; Courses and Scholarships are in More.
- Forms use progressive disclosure. Creation and selected-item details use an inspector instead of consuming the main work surface.

## Interaction rules

Every interactive element has default, hover, focus-visible, active, disabled, loading, success, and error treatment. Empty, offline, partial-success, and conflict states name what happened and offer the next safe action. Focus is restored after overlays close. Motion respects `prefers-reduced-motion`.

Ionic primitives may be used behind Coqui-owned adapters for modal, popover, toast, segmented control, toggle, checkbox, search, progress, skeleton, and compact action sheets. React Bits-inspired content and list transitions are local, restrained adaptations; shader effects, custom cursors, glass layers, bouncing controls, and decorative choreography are prohibited.
