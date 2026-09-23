import type { PdfOutlineEntry } from "../../pdfdocumenteditor";

/**
 * Entries arrive bounded and stripped from the core, and a destination is
 * opaque: it goes back to goToDestination and is never rendered.
 */
export function OutlinePanel({
  entries,
  onSelectDestination,
}: {
  entries: PdfOutlineEntry[];
  onSelectDestination: (destination: unknown) => void;
}) {
  return (
    <nav aria-label="Contents" className="outline-panel">
      <OutlineList
        depth={0}
        entries={entries}
        onSelectDestination={onSelectDestination}
      />
    </nav>
  );
}

function OutlineList({
  depth,
  entries,
  onSelectDestination,
}: {
  depth: number;
  entries: PdfOutlineEntry[];
  onSelectDestination: (destination: unknown) => void;
}) {
  return (
    <ul className="outline-list stack xxs">
      {entries.map((entry) => (
        <li className="outline-item" key={entry.id}>
          <button
            className="outline-entry ghost"
            disabled={entry.destination === null}
            onClick={() => onSelectDestination(entry.destination)}
            style={{
              fontStyle: entry.italic ? "italic" : undefined,
              fontWeight: entry.bold
                ? "var(--theme-weight-semibold)"
                : undefined,
              paddingInlineStart: `calc(var(--theme-space-sm) + ${depth} * var(--theme-space-md))`,
            }}
            type="button"
          >
            {entry.title}
          </button>
          {entry.items.length > 0 ? (
            <OutlineList
              depth={depth + 1}
              entries={entry.items}
              onSelectDestination={onSelectDestination}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
