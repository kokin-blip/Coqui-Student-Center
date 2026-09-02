# Coqui interface system

## Direction

The shell is calm and balanced, with the selective personality of the Scholarship exploration and an optional compact Power density. The primary identity is a friendly geometric frog face with a lowercase `coqui` wordmark. The face-only mark is used for the app, installer, tray-scale, and compact navigation identities; the responsive wordmark is used when at least 112px of horizontal space is available. Never render the face below 20px or the wordmark below 112px wide. A one-color/negative-space state is available through `AppLogo`'s `monochrome` variant.

The default theme follows the operating system; Light and Dark can be selected explicitly. Comfortable density is the default and Power density is optional. The interface uses one restrained deep-green/mint accent family. Amber, coral, red, and blue are semantic colors, not decoration.

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
