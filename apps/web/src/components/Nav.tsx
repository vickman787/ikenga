"use client";

import { useEffect, useState } from "react";

/**
 * Ikenga nav — logo, section links, the Hire pill, and a grouped mobile
 * menu sheet. No status chip: the site speaks for itself.
 */
const LINKS: [string, string][] = [
  ["#services", "Services"],
  ["#how", "How it works"],
  ["#work", "Real work"],
  ["#cfo", "The AI CFO"],
  ["#pay", "Ikenga Pay"],
  ["https://github.com/vickman787/ikenga/tree/main/docs", "Docs"],
];

const GROUPS: { title: string; items: [string, string, string?][] }[] = [
  {
    title: "Hire the team",
    items: [
      ["#services", "Services", "4 jobs, $1 each"],
      ["#how", "How it works"],
      ["#work", "Real work"],
      ["#pay", "Pay in USDT or cNGN"],
      ["#questions", "Questions"],
    ],
  },
  {
    title: "How Ikenga runs",
    items: [
      ["#cfo", "The AI CFO"],
      ["#money", "Follow the money"],
      ["#team", "The team"],
      ["#office", "The office"],
    ],
  },
  {
    title: "Proof",
    items: [
      ["/api/cfo", "The CFO's signed log"],
      ["/api/traction", "Live numbers"],
      ["https://github.com/vickman787/ikenga", "Source code"],
    ],
  },
];

export default function Nav() {
  const [menu, setMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`nav${scrolled ? " scrolled" : ""}${menu ? " open" : ""}`}>
      <div className="nav__bar">
        <a href="#top" className="nav__logo" aria-label="Ikenga home">
          <img src="/logo-mark.png" alt="" className="nav__mark-img" width={34} height={34} /> Ikenga
        </a>
        <nav className="nav__links" aria-label="Sections">
          {LINKS.map(([href, label]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        <a href="#hire" className="pill dark nav__cta">
          Hire Ikenga — $1 <span className="pill__ic">→</span>
        </a>
        <button
          type="button"
          className="pill dark nav__menu"
          aria-label="Menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          Menu <span className="pill__ic">{menu ? "×" : "="}</span>
        </button>
      </div>
      <nav className="nav__sheet" aria-hidden={!menu}>
        {GROUPS.map((g) => (
          <div key={g.title} className="nav__group">
            <span className="mono nav__gt">{g.title}</span>
            {g.items.map(([href, label, note]) => (
              <a key={href} href={href} onClick={() => setMenu(false)}>
                {label}
                {note && <small>{note}</small>}
              </a>
            ))}
          </div>
        ))}
        <a href="#hire" className="pill dark" style={{ justifySelf: "start", marginTop: 12 }} onClick={() => setMenu(false)}>
          Hire Ikenga — $1 <span className="pill__ic">→</span>
        </a>
      </nav>
    </header>
  );
}
