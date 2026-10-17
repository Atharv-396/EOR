import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import "./landing.css";

/**
 * Public landing page for EOR (global hiring, employee management and freelancer workflows).
 * Route: /home (see App.tsx). All styles live in landing.css and are scoped under .eorl.
 *
 * TODO(confirm) before release:
 *  - Work visibility feature wording, and the EOR vs freelancer legal wording.
 *  - Real contact details, About page and legal pages (links currently use "#").
 *  - Demo form destination (see handleSubmit).
 */

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Figtree:wght@400;500;600&family=Caveat:wght@600&display=swap";

// Demo requests: set VITE_DEMO_REQUEST_URL to a same-origin API route (the server CSP only allows
// connect-src 'self'), or set VITE_CONTACT_EMAIL to fall back to the visitor's email app.
const DEMO_URL = import.meta.env.VITE_DEMO_REQUEST_URL as string | undefined;
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL as string | undefined;

type Status = "idle" | "sending" | "sent" | "error" | "unavailable";
const notes: Record<Status, string> = {
  idle: "",
  sending: "Sending...",
  sent: "Thank you. The team will contact you soon.",
  error: "Something went wrong. Please try again.",
  unavailable: "Demo requests are not set up yet. Please contact the team directly.",
};

export default function LandingPage() {
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS_HREF;
    document.head.appendChild(link);

    const root = document.documentElement;
    const prevBehavior = root.style.scrollBehavior;
    const prevPadding = root.style.scrollPaddingTop;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.style.scrollBehavior = reduce ? "auto" : "smooth";
    root.style.scrollPaddingTop = "90px";

    const prevTitle = document.title;
    document.title = "EOR: hire talent globally, manage your workforce in one place";

    return () => {
      link.remove();
      root.style.scrollBehavior = prevBehavior;
      root.style.scrollPaddingTop = prevPadding;
      document.title = prevTitle;
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (DEMO_URL) {
      setStatus("sending");
      try {
        const res = await fetch(DEMO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error("Request failed");
        setStatus("sent");
        form.reset();
      } catch {
        setStatus("error");
      }
      return;
    }
    if (CONTACT_EMAIL) {
      const subject = encodeURIComponent("EOR demo request");
      const text = encodeURIComponent(`Name: ${data.name}\nEmail: ${data.email}\nInterest: ${data.interest}`);
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${text}`;
      return;
    }
    setStatus("unavailable");
  }

  return (
    <div className="eorl">
      <div className="eorl-navw"><header className="eorl-nav">
        <a className="eorl-brand" href="#top">EOR <i aria-hidden="true">GLOBAL</i></a>
        <nav className="eorl-links" aria-label="Main"><a href="#global-hiring">Global Hiring</a><a href="#employee-management">Employee Management</a><a href="#features">Features</a><a href="#contact">About / Contact</a></nav>
        <div className="eorl-act"><Link className="eorl-signin" to="/login">Sign in</Link><a className="eorl-btn eorl-sm" href="#contact">Request a Demo</a></div>
      </header></div>

      <main id="top">
      <section className="eorl-hero"><div className="eorl-wrap">
        <div>
          <h1>Hire talent globally. Manage your workforce in one place.</h1>
          <p className="eorl-lead">EOR supports international hiring, employee management and freelancer workflows, with hiring, onboarding, documents and HR records organised in one platform.</p>
          <div className="eorl-row"><a className="eorl-btn" href="#global-hiring">Explore Global Hiring</a><a className="eorl-btn eorl-ghost" href="#contact">Request a Demo</a></div>
        </div>
        <div className="eorl-net" role="img" aria-label="Illustration of talent in four countries connected to one EOR workspace">
          <svg viewBox="0 0 460 380" aria-hidden="true">
            <path className="eorl-arc" d="M70 80Q150 70 230 190"/><path className="eorl-arc" d="M390 70Q320 80 230 190"/><path className="eorl-arc" d="M60 300Q150 310 230 190"/><path className="eorl-arc" d="M400 310Q320 300 230 190"/>
            <circle cx="230" cy="190" r="44" fill="#2F5BEA"/><text x="230" y="197" textAnchor="middle" fill="#fff" fontFamily="Bricolage Grotesque,sans-serif" fontWeight="700" fontSize="22">EOR</text>
            <g fill="#F5B83D"><circle cx="70" cy="80" r="9"/><circle cx="390" cy="70" r="9"/><circle cx="60" cy="300" r="9"/><circle cx="400" cy="310" r="9"/></g>
            <g fill="#C9D2EE" fontFamily="Figtree,sans-serif" fontSize="14"><text x="48" y="58">Brazil</text><text x="366" y="50">Germany</text><text x="30" y="330">Philippines</text><text x="392" y="340">India</text></g>
          </svg>
          <span className="eorl-chip" style={{ right: 0, top: '34%' }}>Contract signed<small>Sample data</small></span>
          <span className="eorl-chip" style={{ left: 0, top: '50%' }}>Onboarding 2 of 4<small>Sample data</small></span>
          <span className="eorl-hand" aria-hidden="true">one workspace, many countries</span>
        </div>
      </div></section>

      <section id="global-hiring"><div className="eorl-wrap">
        <h2>Global hiring and recruitment</h2>
        <p className="eorl-sub">The main thing EOR does: keep international hiring organised from first candidate to first day.</p>
        <div className="eorl-bento">
          <div className="eorl-tile eorl-t-a"><div><h3>Organise international recruitment</h3><p>Help recruiters and companies work with talent in different countries, with every step visible.</p></div><span className="eorl-big" aria-hidden="true">01</span></div>
          <div className="eorl-tile eorl-t-b"><h3>Candidate and worker information</h3><p>Manage candidate and worker details in one record instead of across emails and spreadsheets.</p></div>
          <div className="eorl-tile eorl-t-c"><h3>Onboarding</h3><p>Organise onboarding steps for each new hire.</p></div>
          <div className="eorl-tile eorl-t-d"><h3>Documents and hiring tasks</h3><p>Keep documents and tasks together so nothing is missed.</p></div>
        </div>
      </div></section>

      <section id="how" style={{ paddingTop: 0 }}><div className="eorl-wrap">
        <h2 style={{ textAlign: 'center' }}>How global hiring works</h2>
        <ol className="eorl-path">
          <li><h3>Find talent in another country</h3><p>Identify the right candidate wherever they are.</p></li>
          <li><h3>Organise hiring and onboarding</h3><p>Collect hiring information and onboarding details in one place.</p></li>
          <li><h3>Arrange the engagement</h3><p>Set up the appropriate employment or freelancer arrangement.</p></li>
          <li><h3>Manage ongoing work</h3><p>Keep records and tasks up to date as the work continues.</p></li>
        </ol>
      </div></section>

      <section id="employee-management" className="eorl-alt"><div className="eorl-wrap">
        <h2>Employee management</h2>
        <p className="eorl-sub">Powered by EMP Cloud, the HR module of EOR. Choose a topic to see what it covers.</p>
        <div className="eorl-tabs">
          <input type="radio" name="t" id="eorl-t1" defaultChecked aria-label="Profiles and records" /><input type="radio" name="t" id="eorl-t2" aria-label="Attendance and leave" /><input type="radio" name="t" id="eorl-t3" aria-label="Documents and policies" /><input type="radio" name="t" id="eorl-t4" aria-label="Updates and HR tasks" />
          <div className="eorl-tl"><label htmlFor="eorl-t1">Profiles and records</label><label htmlFor="eorl-t2">Attendance and leave</label><label htmlFor="eorl-t3">Documents and policies</label><label htmlFor="eorl-t4">Updates and HR tasks</label></div>
          <div className="eorl-pn">
            <div id="eorl-p1"><h3>Profiles and records</h3><p>Every employee in one searchable directory.</p><ul><li>Employee profiles and details</li><li>Departments and reporting lines</li><li>Org chart view</li></ul></div>
            <div id="eorl-p2"><h3>Attendance and leave</h3><p>Time and time off without the back and forth.</p><ul><li>Shifts, check-in and check-out</li><li>Leave requests with multi-level approvals</li><li>Leave balances at a glance</li></ul></div>
            <div id="eorl-p3"><h3>Documents and policies</h3><p>Store what matters and know who has seen it.</p><ul><li>Employee documents with expiry tracking</li><li>Company policies</li><li>Acknowledgement tracking</li></ul></div>
            <div id="eorl-p4"><h3>Updates and HR tasks</h3><p>Keep everyone informed and HR work moving.</p><ul><li>Company announcements</li><li>Employee updates</li><li>Everyday HR tasks</li></ul></div>
          </div>
        </div>
      </div></section>

      <section id="freelancers"><div className="eorl-wrap">
        <h2>Freelancer management</h2>
        <p className="eorl-sub">Work with independent talent without a separate spreadsheet for each person.</p>
        <div className="eorl-led">
          <div><b>one</b><h3>Freelancer and engagement records</h3><p>Keep each freelancer's details and engagement information together.</p></div>
          <div><b>two</b><h3>Contracts and onboarding</h3><p>Store contract and onboarding details with the rest of the record.</p></div>
          <div><b>three</b><h3>Project administration</h3><p>Track the administrative tasks that come with each project.</p></div>
        </div>
      </div></section>

      <section id="features" style={{ paddingTop: 0 }}><div className="eorl-wrap"><div className="eorl-panel">
        <div><h2>Additional features</h2><p className="eorl-sub">Supporting tools that keep the whole workforce visible.</p></div>
        <div className="eorl-fl">
          <div><h3>Work visibility</h3><p>Understand work status across your team, where supported by the platform. {/* TODO(confirm): feature scope */}</p></div>
          <div><h3>HR reports</h3><p>Workforce status and HR reports in one view.</p></div>
          <div><h3>Document tracking</h3><p>Know which documents are collected, pending or expiring.</p></div>
          <div><h3>Task management</h3><p>Assign and follow up on hiring and HR tasks.</p></div>
        </div>
      </div></div></section>

      <section className="eorl-why" style={{ paddingTop: 0 }}><div className="eorl-wrap">
        <h2 style={{ marginBottom: '36px' }}>Why EOR?</h2>
        <div className="eorl-wi"><b>01</b><p>Hiring and HR information, together in one place.</p></div>
        <div className="eorl-wi"><b>02</b><p>Fewer scattered documents, spreadsheets and manual follow-ups.</p></div>
        <div className="eorl-wi"><b>03</b><p>Global workforce administration that is easier to manage.</p></div>
      </div></section>

      <section id="eor-vs-freelancer" className="eorl-alt"><div className="eorl-wrap">
        <h2>EOR or freelancer: what's the difference?</h2>
        <p className="eorl-sub">Two ways to work with someone in another country. The right one depends on the role.</p>
        <div className="eorl-tw"><table>
          <thead><tr><th scope="col"></th><th scope="col">Employer of Record</th><th scope="col">Freelancer</th></tr></thead>
          <tbody>
            <tr><th scope="row">Relationship</th><td data-l="Employer of Record">Legally employed through an Employer of Record arrangement.</td><td data-l="Freelancer">Independent contractor, not an employee.</td></tr>
            <tr><th scope="row">Best for</th><td data-l="Employer of Record">Ongoing, full-time or long-term roles.</td><td data-l="Freelancer">Specific projects or flexible work.</td></tr>
            <tr><th scope="row">Paperwork</th><td data-l="Employer of Record">Employment contract.</td><td data-l="Freelancer">Freelancer agreement.</td></tr>
            <tr><th scope="row">Payroll and tax</th><td data-l="Employer of Record">Handled as part of the arrangement, where properly arranged.</td><td data-l="Freelancer">Set out in the freelancer agreement.</td></tr>
          </tbody>
        </table></div>
        <p className="eorl-note">Legal employment, payroll, tax and related services are offered only where properly arranged. {/* TODO(confirm): company legal wording */}</p>
      </div></section>

      <section id="faq"><div className="eorl-wrap eorl-fq">
        <aside><h2>Frequently asked questions</h2><p className="eorl-sub">Short answers to the questions we hear first.</p><a href="#contact">Ask the team</a></aside>
        <div>
          <details open><summary>What is EOR?</summary><p>EOR is a platform for hiring talent in other countries and managing your workforce in one place. It brings together global hiring, employee management and freelancer workflows. EMP Cloud is its HR module for employee records, attendance, leave, documents and policies.</p></details>
          <details><summary>How does global hiring work?</summary><p>You find talent in another country, organise hiring information and onboarding, arrange the appropriate employment or freelancer engagement, and then manage ongoing records and tasks.</p></details>
          <details><summary>What is the difference between EOR and a freelancer?</summary><p>With an Employer of Record arrangement, the person is legally employed through the EOR. A freelancer is an independent contractor engaged for specific work. Legal employment, payroll and tax services are offered only where properly arranged.</p></details>
          <details><summary>What employee management features are available?</summary><p>Employee profiles and records, attendance and leave management, documents and company policies, employee updates and HR tasks.</p></details>
        </div>
      </div></section>

      <section id="contact" style={{ paddingTop: 0 }}><div className="eorl-wrap"><div className="eorl-demo">
        <div><h2>See EOR in action</h2><p>Request a demo or contact the team to talk through your hiring and workforce needs.</p></div>
        <form onSubmit={handleSubmit}>
          <div><label htmlFor="n">Your name</label><input type="text" id="n" name="name" autoComplete="name" required /></div>
          <div><label htmlFor="e">Work email</label><input type="email" id="e" name="email" autoComplete="email" required /></div>
          <div><label htmlFor="i">What do you need?</label><select id="i" name="interest"><option>Hire talent globally</option><option>Manage employees</option><option>Work with freelancers</option><option>Something else</option></select></div>
          <button className="eorl-btn" type="submit" disabled={status === "sending"}>Request a Demo</button>
          <p className="eorl-formnote" role="status">{notes[status]}</p>
        </form>
      </div></div></section>
      </main>

      <footer><div className="eorl-wrap">
        <div className="eorl-fr">
          <div><a className="eorl-brand" href="#top" style={{ color: 'var(--ink)' }}>EOR</a><p className="eorl-sub" style={{ marginTop: '8px' }}>Global hiring, employee management and freelancer workflows in one platform.</p><p className="eorl-sub">{/* TODO: company address, email, phone */}Contact details here</p></div>
          <ul className="eorl-fl2">
            <li><a href="#global-hiring">Global Hiring</a></li><li><a href="#employee-management">Employee Management</a></li><li><a href="#freelancers">Freelancers</a></li><li><a href="#features">Features</a></li><li><a href="#faq">FAQs</a></li>
            <li><Link to="/login">Sign in</Link></li><li><Link to="/register">Register your organization</Link></li><li><a href="#">About</a></li><li><a href="#">Privacy Policy</a></li><li><a href="#">Terms and Conditions</a></li><li><a href="#">Cookie Policy</a></li>
          </ul>
        </div>
        <p className="eorl-copy">© 2026 EOR. All rights reserved.</p>
      </div></footer>
    </div>
  );
}
