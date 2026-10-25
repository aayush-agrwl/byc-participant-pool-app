// ---------------------------------------------------------------------------
// Participant-facing behaviour.
//
// The sign-in token is kept in sessionStorage rather than localStorage on
// purpose: students register from shared campus machines, and a token that
// survives closing the tab is a way for the next person at that desk to open
// somebody else's record.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "brl_participant_token";
const FLASH_KEY = "brl_flash";

const $  = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let state = { participant: null, studies: [], bookings: [], config: null };

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function token() { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(value) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch { /* an empty body is fine */ }
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong. Please try again.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function text(value) {
  const node = document.createElement("div");
  node.textContent = value == null ? "" : String(value);
  return node.innerHTML;
}

function showMessage(selector, kind, message) {
  const node = $(selector);
  if (!node) return;
  node.className = `message ${kind}`;
  node.innerHTML = message;
  node.hidden = false;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideMessage(selector) {
  const node = $(selector);
  if (node) node.hidden = true;
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const config = await api("/api/config");
    state.config = config;

        setText("#rule-gap",    `${config.minDaysBetweenStudies} days`);
    setText("#rule-noshow", `${config.noShowsBeforeSuspension} no-shows`);
    setText("#consent-version-note", `Pool consent text ${config.consentVersion}.`);

    if (!config.poolOpen) {
      showMessage("#register-message", "warn",
        "Registration for the pool is closed at the moment. The page will accept sign-ups again when the lab reopens it.");
            const submit = $("#register-submit");
      if (submit) submit.disabled = true;
    }

    const container = $("#public-studies");
        if (!container) return;
    container.classList.remove("loading");
    if (config.studies.length === 0) {
      container.innerHTML = `<p class="field-note" style="margin:0">
        No study is recruiting right now. Registering for the pool means the lab can contact
        you when the next one opens.</p>`;
      return;
    }
    container.innerHTML = config.studies.map((study) => `
      <div class="study">
        <div class="study-head">
          <div>
            <h3>${text(study.title)}</h3>
            <p class="field-note" style="margin:0">${text(study.summary)}</p>
            <div class="study-meta">
              <span>${text(study.durationMinutes)} minutes</span>
              ${study.incentive ? `<span>${text(study.incentive)}</span>` : ""}
              <span>Ages ${text(study.minAge)} to ${text(study.maxAge)}</span>
              ${study.requiresStudent ? "<span>Enrolled students</span>" : ""}
            </div>
          </div>
          <span class="pill ${study.openSessions > 0 ? "good" : "quiet"}">
            ${study.openSessions > 0 ? `${study.openSessions} session${study.openSessions === 1 ? "" : "s"} open` : "Fully booked"}
          </span>
        </div>
      </div>
    `).join("");
  } catch {
       setText("#public-studies", "The study list could not be loaded. Please refresh the page.");
  }
}

// ---------------------------------------------------------------------------
// Register and sign in
// ---------------------------------------------------------------------------

function registrationPayload(form) {
  const data = new FormData(form);
  return {
    name:        (data.get("name")  || "").trim(),
    email:       (data.get("email") || "").trim(),
    phone:       (data.get("phone") || "").trim(),
    yearOfBirth: Number(data.get("yearOfBirth")),
    gender:      data.get("gender") || "",
    isStudent:   data.get("isStudent") === "yes",
    institution: (data.get("institution") || "").trim(),
    department:  (data.get("department")  || "").trim(),
    programme:   data.get("programme") || "",
    yearOfStudy: (data.get("yearOfStudy") || "").trim(),
    languages:   data.getAll("languages"),
    howHeard:    (data.get("howHeard") || "").trim(),
    confirmAdult: data.get("confirmAdult") === "on",
    consent:      data.get("consent") === "on",
  };
}

async function handleRegister(event) {
  event.preventDefault();
  hideMessage("#register-message");
  const button = $("#register-submit");
  button.disabled = true;
  button.textContent = "Registering.";
  try {
    const result = await api("/api/register", { method: "POST", body: registrationPayload(event.target) });
    setToken(result.token);
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({
      kind: "success",
      html: `You are on the register as <strong>${text(result.participant.code)}</strong>. Keep that reference: the lab uses it instead of your name. Pick a session below when you are ready.`,
    }));
    applyPortal(result);
    } catch (error) {
    showMessage("#register-message", "error", text(error.message));
  } finally {
    button.disabled = false;
    button.textContent = "Register";
  }
}

let pendingEmail = "";

async function handleSignIn(event) {
  event.preventDefault();
  hideMessage("#signin-message");
  const email = String(new FormData(event.target).get("email") || "").trim();
  try {
    const result = await api("/api/login/request", { method: "POST", body: { email } });
    pendingEmail = email;
    $("#signin-form").hidden = true;
    $("#code-form").hidden = false;
    setText("#code-sent-note", result.message);
    if (result.devCode) {
      const note = $("#code-test-note");
      if (note) {
        note.textContent = `Test mode: your code is ${result.devCode}. Turn test mode off before the site goes live.`;
        note.hidden = false;
      }
    }
  } catch (error) {
    showMessage("#signin-message", "error", text(error.message));
  }
}

async function handleVerifyCode(event) {
  event.preventDefault();
  hideMessage("#signin-message");
  const code = String(new FormData(event.target).get("code") || "").trim();
  try {
    const result = await api("/api/login/verify", { method: "POST", body: { email: pendingEmail, code } });
    setToken(result.token);
    applyPortal(result);
  } catch (error) {
    showMessage("#signin-message", "error", text(error.message));
  }
}

function backToEmail() {
  pendingEmail = "";
  $("#code-form").hidden = true;
  $("#signin-form").hidden = false;
  const note = $("#code-test-note");
  if (note) note.hidden = true;
  hideMessage("#signin-message");
}

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

function showFlash() {
  const raw = sessionStorage.getItem(FLASH_KEY);
  if (!raw) return;
  sessionStorage.removeItem(FLASH_KEY);
  const flash = JSON.parse(raw);
  showMessage("#portal-message", flash.kind, flash.html);
}

function applyPortal(payload) {
  state.participant = payload.participant;
  state.studies     = payload.studies  || [];
  state.bookings    = payload.bookings || [];
  if (payload.token) setToken(payload.token);

  if (!$("#portal")) {
    window.location.href = "/";
    return;
  }
  $("#landing").hidden = true;
  $("#portal").hidden = false;
  window.scrollTo({ top: 0 });
  renderPortal();
    showFlash();
}

function renderPortal() {
  const p = state.participant;
  $("#portal-code").textContent = p.code;
  $("#portal-greeting").textContent = `Hello, ${p.name.split(" ")[0]}`;

  const standing = $("#portal-standing");
  if (p.status === "suspended") {
    const until = p.suspendedUntil
      ? new Date(p.suspendedUntil).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" })
      : "further notice";
    standing.innerHTML = `<div class="message warn">
      Your pool membership is paused until ${text(until)} after ${text(p.noShowCount)} unexplained absences.
      Write to the Lab Manager if you think that is wrong: absences you told the lab about in advance do not count.
    </div>`;
  } else if (p.status === "withdrawn") {
    standing.innerHTML = `<div class="message info">
      You have withdrawn from the pool. Write to the lab if you would like to rejoin.
    </div>`;
  } else {
    standing.innerHTML = "";
  }

  renderBookings();
  renderStudies();
    renderDetails();
}

function renderBookings() {
  const container = $("#my-bookings");
  const live = state.bookings.filter((b) => b.status !== "cancelled");
  if (live.length === 0) {
    container.innerHTML = `<p class="field-note" style="margin:0">You have no sessions booked. Choose one below.</p>`;
    return;
  }
  const labels = {
    booked: ["wine", "Booked"],
    attended: ["good", "Attended"],
    late_admitted: ["good", "Attended, late"],
    no_show: ["bad", "Recorded absent"],
    turned_away: ["quiet", "Turned away, session was full"],
    withdrawn: ["quiet", "Withdrawn"],
  };
  container.innerHTML = live.map((booking) => {
    const [tone, label] = labels[booking.status] || ["quiet", booking.status];
    const upcoming = booking.status === "booked" && new Date(booking.startsAt) > new Date();
    return `
      <div class="study">
        <div class="study-head">
          <div>
            <h3>${text(booking.studyTitle)}</h3>
            <div class="study-meta">
              <span><strong>${text(booking.label)}</strong></span>
              ${booking.location ? `<span>${text(booking.location)}</span>` : ""}
              <span>${text(booking.durationMinutes)} minutes</span>
              ${booking.incentive ? `<span>${text(booking.incentive)}</span>` : ""}
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <span class="pill ${tone}">${text(label)}</span>
            ${upcoming ? `<button class="button small secondary" data-cancel="${booking.id}">Cancel this seat</button>` : ""}
          </div>
        </div>
        ${upcoming ? `<div class="study-body"><p class="field-note" style="margin:0">
          Bring a photo ID. If you cannot come, cancel here rather than not turning up: a
          cancellation costs you nothing, an unexplained absence counts against your record.
        </p></div>` : ""}
      </div>`;
  }).join("");

  $$("[data-cancel]").forEach((button) => {
    button.addEventListener("click", () => cancelBooking(button.dataset.cancel));
  });
}

function renderStudies() {
  const container = $("#portal-studies");
  if (state.studies.length === 0) {
    container.innerHTML = `<p class="field-note" style="margin:0">
      No study is recruiting right now. The lab will contact you when the next one opens.</p>`;
    return;
  }

  container.innerHTML = state.studies.map((study) => {
    const bookable = study.eligible && study.sessions.some((s) => !s.full && !s.blocked);

    const head = `
      <div class="study-head">
        <div>
          <h3>${text(study.title)}</h3>
          <p class="field-note" style="margin:0">${text(study.summary)}</p>
          <div class="study-meta">
            <span>${text(study.durationMinutes)} minutes</span>
            ${study.incentive ? `<span>${text(study.incentive)}</span>` : ""}
            ${study.venue ? `<span>${text(study.venue)}</span>` : ""}
            ${study.piName ? `<span>Principal investigator: ${text(study.piName)}</span>` : ""}
            <span>Ethics approval ${text(study.rcecReference)}</span>
          </div>
        </div>
        <span class="pill ${study.eligible ? "good" : "quiet"}">${study.eligible ? "You can take this" : "Not open to you"}</span>
      </div>`;

    if (!study.eligible) {
      return `<div class="study ineligible">${head}<div class="study-body">
        <div class="message info" style="margin:0">
          <strong>Why you cannot sign up</strong>
          <ul>${study.reasons.map((r) => `<li>${text(r.message)}</li>`).join("")}</ul>
        </div>
      </div></div>`;
    }

    if (study.sessions.length === 0) {
      return `<div class="study">${head}<div class="study-body">
        <p class="field-note" style="margin:0">No session times have been published yet. Check back in a few days.</p>
      </div></div>`;
    }

    const slots = study.sessions.map((session) => {
      const unavailable = session.full || session.blocked;
      // A session blocked by the interval says so on the slot itself, because
      // "you can take this study but not that day" is only useful if the
      // participant can see which day is the problem.
      const note = session.blocked
        ? text(session.blockedReason)
        : session.full
          ? "Full"
          : `${session.remaining} seat${session.remaining === 1 ? "" : "s"} left`;
      return `
      <label class="slot ${unavailable ? "is-full" : ""}">
        <input type="radio" name="session-${study.id}" value="${session.id}" ${unavailable ? "disabled" : ""}>
        <span>
          <span class="when">${text(session.label)}</span>
          ${session.location ? `<span class="where">${text(session.location)}</span>` : ""}
          <span class="left">${note}</span>
        </span>
      </label>`;
    }).join("");

        const pretest = !study.pretest || study.pretest.length === 0 ? "" : `
      <h4 style="margin-top:22px">Short check for this study</h4>
      <p class="field-note">Please answer each question. The study needs everyone taking part to meet its requirements.</p>
      ${study.pretest.map((q) => `
        <fieldset>
          <legend>${text(q.text)}</legend>
          <div class="radio-row">
            ${q.options.map((option, i) => `
              <label><input type="radio" name="pretest-${study.id}-${text(q.id)}" value="${i}"> ${text(option)}</label>
            `).join("")}
          </div>
        </fieldset>`).join("")}`;

    const declarations = study.declarations.length === 0 ? "" : `
      <h4 style="margin-top:22px">Before you book, please confirm</h4>
      <p class="field-note">These are the checks this study needs from you. Answering honestly protects the study and the payment you are owed.</p>
      ${study.declarations.map((d, i) => `
        <label class="check">
          <input type="checkbox" data-declaration="${study.id}" data-index="${i}">
          <span>${text(d)}</span>
        </label>`).join("")}`;

    return `<div class="study">${head}<div class="study-body">
      <h4>Choose a session time</h4>
      <div class="slot-list">${slots}</div>
            ${pretest}
      <div class="button-row" style="margin-top:20px">
        <button class="button primary" data-book="${study.id}" ${bookable ? "" : "disabled"}>Book this seat</button>
      </div>
      <p class="field-note" id="study-msg-${study.id}" style="margin:10px 0 0"></p>
    </div></div>`;
  }).join("");

  $$("[data-book]").forEach((button) => {
    button.addEventListener("click", () => bookSeat(Number(button.dataset.book), button));
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function renderDetails() {
  const form = $("#details-form");
  if (!form) return;
  const p = state.participant;
  const field = (name) => form.querySelector(`[name="${name}"]`);

  field("name").value        = p.name || "";
  field("institution").value = p.institution || "";
  field("department").value  = p.department || "";
  field("programme").value   = p.programme || "";

  // Records saved before the change may hold "Woman" or "Man". Add them as
  // options so the page shows the value that is actually stored.
  const gender = field("gender");
  if (p.gender && !Array.from(gender.options).some((o) => o.value === p.gender)) {
    gender.add(new Option(p.gender, p.gender));
  }
  gender.value = p.gender || "";
}

async function handleDetails(event) {
  event.preventDefault();
  hideMessage("#details-message");
  const data = new FormData(event.target);
  const programme = (data.get("programme") || "").trim();
  try {
    const result = await api("/api/me/details", {
      method: "POST",
      body: {
        token:       token(),
        name:        (data.get("name") || "").trim(),
        gender:      data.get("gender") || "",
        isStudent:   programme !== "Not a student",
        institution: (data.get("institution") || "").trim(),
        department:  (data.get("department") || "").trim(),
        programme,
      },
    });
    applyPortal(result);
    showMessage("#portal-message", "success", "Your details have been updated.");
  } catch (error) {
    if (error.status === 401) return signOut();
    showMessage("#details-message", "error", text(error.message));
  }
}
async function bookSeat(studyId, button) {
  const study = state.studies.find((s) => s.id === studyId);
  const note  = $(`#study-msg-${studyId}`);
  note.textContent = "";

  const chosen = document.querySelector(`input[name="session-${studyId}"]:checked`);
  if (!chosen) {
    note.textContent = "Please choose a session time first.";
    return;
  }
    const pretestAnswers = {};
  for (const q of study.pretest || []) {
    const chosenAnswer = document.querySelector(`input[name="pretest-${studyId}-${q.id}"]:checked`);
    if (!chosenAnswer) {
      note.textContent = "Please answer every question in the short check.";
      return;
    }
    pretestAnswers[q.id] = Number(chosenAnswer.value);
  }
  const boxes = $$(`input[data-declaration="${studyId}"]`);
  if (boxes.length > 0 && !boxes.every((box) => box.checked)) {
    note.textContent = "Please confirm every statement above before booking.";
    return;
  }

  button.disabled = true;
  button.textContent = "Booking.";
  try {
    const result = await api("/api/bookings", {
      method: "POST",
      body: {
        token: token(),
        sessionId: Number(chosen.value),
        declarations: study.declarations.map(() => true),
                pretest: pretestAnswers,
      },
    });
    applyPortal(result);
    showMessage("#portal-message", "success",
      `Your seat is booked for <strong>${text(result.booking.studyTitle)}</strong> on
       <strong>${text(result.booking.label)}</strong>${result.booking.location ? `, ${text(result.booking.location)}` : ""}.
       Bring a photo ID. If your plans change, cancel here rather than not turning up.`);
  } catch (error) {
    if (error.status === 401) return signOut();
    button.disabled = false;
    button.textContent = "Book this seat";
    note.textContent = error.message;
    await refreshPortal();
  }
}

async function cancelBooking(bookingId) {
  if (!window.confirm("Release this seat? Somebody else can then take it, and you would have to book again.")) return;
  try {
    const result = await api(`/api/bookings/${bookingId}/cancel`, { method: "POST", body: { token: token() } });
    applyPortal(result);
    showMessage("#portal-message", "info", "Your seat has been released. Nothing has been recorded against you.");
  } catch (error) {
    if (error.status === 401) return signOut();
    showMessage("#portal-message", "error", text(error.message));
  }
}

async function refreshPortal() {
  try {
    applyPortal(await api("/api/me", { method: "POST", body: { token: token() } }));
  } catch (error) {
    if (error.status === 401) signOut();
  }
}

async function handleWithdraw() {
  if (!window.confirm("Withdraw from the participant pool? Any seat you hold is released and the lab stops contacting you about studies.")) return;
  try {
    const result = await api("/api/withdraw", { method: "POST", body: { token: token() } });
    setToken(null);
    $("#portal").hidden = true;
    $("#landing").hidden = false;
    window.scrollTo({ top: 0 });
    showMessage("#signin-message", "info", text(result.message));
  } catch (error) {
    showMessage("#portal-message", "error", text(error.message));
  }
}

function signOut() {
  setToken(null);
  state = { participant: null, studies: [], bookings: [], config: state.config };
  $("#portal").hidden = true;
  $("#landing").hidden = false;
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Attach each handler only if its element exists on this page.
function on(selector, event, handler) {
  const node = $(selector);
  if (node) node.addEventListener(event, handler);
}

on("#register-form", "submit", handleRegister);
on("#signin-form", "submit", handleSignIn);
on("#code-form", "submit", handleVerifyCode);
on("#code-back", "click", backToEmail);
on("#refresh-portal", "click", refreshPortal);
on("#signout", "click", signOut);
on("#withdraw", "click", handleWithdraw);
on("#details-form", "submit", handleDetails);

if ($("#rule-gap") || $("#public-studies") || $("#register-form")) loadConfig();
if (token() && $("#portal")) refreshPortal();
