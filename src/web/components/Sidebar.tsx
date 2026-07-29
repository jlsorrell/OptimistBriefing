import type { EditionSection } from "../../contracts/editorial";

export const sectionLabels: Readonly<Record<EditionSection, string>> = {
  morning_brief: "Morning brief",
  research: "Research",
  research_radar: "On the radar",
  world: "World",
  technology: "Technology",
  ai_policy: "AI policy",
  dmv: "DMV",
  baltimore: "Baltimore",
  forecast: "Forecast signals",
};

type SidebarProps = {
  sections: readonly EditionSection[];
  open: boolean;
  onNavigate: () => void;
};

export function Sidebar({ sections, open, onNavigate }: SidebarProps) {
  return (
    <aside className={open ? "sidebar is-open" : "sidebar"}>
      <p className="sidebar-kicker">Today’s edition</p>
      <nav aria-label="Briefing sections">
        <ol>
          {sections.map((section) => (
            <li key={section}>
              <a href={`#${section}`} onClick={onNavigate}>
                <span aria-hidden="true">—</span>
                {sectionLabels[section]}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <nav className="sidebar-utility" aria-label="Briefing tools">
        <a href="/saved">
          <span aria-hidden="true">☆</span>
          Saved items
        </a>
        <a href="/archive">
          <span aria-hidden="true">⌘</span>
          Archive
        </a>
        <a href="/preferences">
          <span aria-hidden="true">◌</span>
          Preferences
        </a>
      </nav>
    </aside>
  );
}
