# `@apex/ui`

The shared design-system components for the web app.

Reference: [Phase 5 §3](../../docs/architecture/05-frontend-design.md#3-design-system).

Composition rule: Radix UI primitives provide accessibility behavior; this package wraps them with the Apex visual identity (glass surfaces, ink base, cyan/violet accents). Tokens live in `apps/web/src/styles/tokens.css` and are mirrored into Tailwind via `theme.extend`.

Inventory (highlights):
- Primitives: `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Combobox`, `Switch`, `Checkbox`, `Radio`, `Slider`, `Dialog`, `Drawer`, `Sheet`, `Popover`, `Tooltip`, `Toast`, `Tabs`, `Accordion`, `DropdownMenu`, `ContextMenu`, `Form`, `Field`, `Label`, `HelpText`, `Kbd`, `Skeleton`, `Spinner`, `EmptyState`.
- Composites: `Glass`, `Card`, `MetricTile`, `StatusPill`, `FreshnessBadge`, `ProgressRing`, `ScoreMeter`, `TimelineItem`, `ChartFrame`, `DataTable`, `Diff`, `CodeBlock`, `Avatar`, `IdentityChip`, `PlatformIcon`.

A11y target: WCAG 2.2 AA; AAA contrast on every shipped token.
