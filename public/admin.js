// ---------------------------------------------------------------------------
// Lab dashboard.
//
// Session times are rendered by the server, which pins them to Asia/Kolkata.
// Nothing in this file formats a timestamp itself: a clock that reads five and
// a half hours out on the deployed site and correctly on a laptop in Bangalore
// is the kind of bug nobody finds until a participant is standing outside a
// locked room.
// ---------------------------------------------------------------------------

const $  = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let cache = { studies: [], participants: [], rules: null };

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401) {
    window.location.href = "/admin-login";
    throw new Error("Signed out.");
  }
  let data = {};
  try { data = await response.json(); } catch { /* empty body */ }
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function text(value) {
  const node = document.createElement("div");
  node.textContent = value == null ? "" : String(value);
  return node.innerHTML;
}

function flash(kind, message, selector = "#global-message") {
  const node = $(selector);
  node.className = `message ${kind}`;
  node.innerHTML = message;
  node.hidden = false;
  if (selector === "#global-message") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => { node.hidden = true; }, 9000);
  }
}

function openModal(id)  { $(`#${id}`).hidden = false; }
function closeModal(id) { $(`#${id}`).hidden = true; }

$$("[data-close]").forEach((button) => {
  button.addEventListener("click", () => closeModal(button.dataset.close));
});
$$(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.hidden = true;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $$(".modal-backdrop").forEach((b) => { b.hidden = true; });
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const LOADERS = {
  overview:     loadOverview,
  studies:      loadStudies,
  participants: loadParticipants,
  rules:        loadRules,
  activity:     loadActivity,
};

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $$("[role=tabpanel]").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${tab.dataset.tab}`;
    });
    LOADERS[tab.dataset.tab]();
  });
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function loadOverview() {
  const data = await api("/api/admin/overview");
  cache.rules = data.rules;

  $("#overview-facts").innerHTML = [
    ["Participants on the register", data.pool.total],
    ["Active", data.pool.active],
    ["Paused after no-shows", data.pool.suspended],
    ["Registered in the last 7 days", data.pool.last_seven_days],
    ["Studies open for sign-up", data.studies.open],
    ["Seats booked and not yet sat", data.bookings.booked],
    ["Sessions attended", data.bookings.attended],
    ["No-shows recorded", data.bookings.no_shows],
  ].map(([label, value]) => `
    <div class="fact"><span class="value">${text(value)}</span><span class="label">${text(label)}</span></div>
  `).join("");

  const upcoming = $("#upcoming-sessions");
  if (data.upcoming.length === 0) {
    upcoming.innerHTML = `<p class="field-note" style="margin:0">No sessions are scheduled. Add one under Studies and sessions.</p>`;
    return;
  }
  upcoming.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>When</th><th>Study</th><th>Where</th>
      <th class="numeric">Booked</th><th class="numeric">Seats</th><th class="numeric">Room</th><th></th>
    </tr></thead>
    <tbody>${data.upcoming.map((s) => `
      <tr>
        <td><strong>${text(s.label)}</strong></td>
        <td>${text(s.studyCode)} ${text(s.studyTitle)}</td>
        <td>${text(s.location)}</td>
        <td class="numeric">${text(s.taken)}</td>
        <td class="numeric">${text(s.seats)}</td>
        <td class="numeric">${text(s.capacity)}</td>
        <td><button class="button small secondary" data-roster="${s.id}">Roster</button></td>
      </tr>`).join("")}
    </tbody></table></div>
    <p class="field-note" style="margin-top:12px">
      <strong>Seats</strong> is the room capacity plus the study's over-recruitment buffer, so it is
      deliberately above <strong>Room</strong>. Anybody turned away at the door is paid the show-up fee.
    </p>`;
  bindRosterButtons();
}

// ---------------------------------------------------------------------------
// Studies and sessions
// ---------------------------------------------------------------------------

async function loadStudies() {
  const studies = await api("/api/admin/studies");
  cache.studies = studies;
  const container = $("#studies-list");
  container.classList.remove("loading");

  if (studies.length === 0) {
    container.innerHTML = `<div class="card"><p style="margin:0">No studies yet. Create one to start recruiting.</p></div>`;
    return;
  }

  const tone = { open: "good", draft: "quiet", closed: "warn" };
  container.innerHTML = studies.map((study) => `
    <div class="card">
      <div class="panel-head">
        <div>
          <p class="eyebrow">${text(study.code)}</p>
          <h2>${text(study.title)}</h2>
          <p>${text(study.summary || "No description.")}</p>
          <div class="study-meta">
            <span>Ages ${text(study.minAge)} to ${text(study.maxAge)}</span>
            <span>${study.requiresStudent ? "Students only" : "Open to non-students"}</span>
            <span>${text(study.durationMinutes)} minutes</span>
            <span>Buffer ${text(study.bufferPercent)} per cent</span>
            ${study.piName ? `<span>PI ${text(study.piName)}</span>` : ""}
          </div>
        </div>
        <div class="button-row">
          <span class="pill ${tone[study.status]}">${text(study.status)}</span>
          <button class="button small secondary" data-edit-study="${study.id}">Edit</button>
          <button class="button small danger" data-delete-study="${study.id}">Delete</button>
        </div>
      </div>

      ${study.rcecReference
        ? `<p class="field-note">Ethics approval <strong>${text(study.rcecReference)}</strong>.</p>`
        : `<div class="message warn">No RCEC approval reference recorded. This study cannot be opened for sign-up until it has one.</div>`}

      <h3 style="margin-top:22px">Sessions</h3>
      ${study.sessions.length === 0
        ? `<p class="field-note">No sessions scheduled.</p>`
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>When</th><th>Where</th>
              <th class="numeric">Booked</th><th class="numeric">Seats</th><th class="numeric">Room</th>
              <th class="numeric">Attended</th><th class="numeric">No-shows</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>${study.sessions.map((s) => `
              <tr>
                <td><strong>${text(s.label)}</strong>${s.notes ? `<br><small>${text(s.notes)}</small>` : ""}</td>
                <td>${text(s.location)}</td>
                <td class="numeric">${text(s.taken)}</td>
                <td class="numeric">${text(s.seats)}</td>
                <td class="numeric">${text(s.capacity)}</td>
                <td class="numeric">${text(s.attended)}</td>
                <td class="numeric">${text(s.noShows)}</td>
                <td><span class="pill ${s.status === "open" ? "good" : "bad"}">${text(s.status)}</span></td>
                <td>
                  <div class="button-row">
                    <button class="button small secondary" data-roster="${s.id}">Roster</button>
                    <button class="button small secondary" data-session-status="${s.id}" data-next="${s.status === "open" ? "cancelled" : "open"}">
                      ${s.status === "open" ? "Cancel" : "Reopen"}
                    </button>
                    <button class="button small danger" data-delete-session="${s.id}">Delete</button>
                  </div>
                </td>
              </tr>`).join("")}
            </tbody></table></div>`}

      <form class="add-session" data-study="${study.id}" style="margin-top:16px">
        <div class="form-grid">
          <label class="field">Date <input type="date" name="date" required></label>
          <label class="field">Start time (IST) <input type="time" name="time" required></label>
          <label class="field">Room capacity <input type="number" name="capacity" min="1" max="200" value="8" required></label>
          <label class="field">Location <input type="text" name="location" placeholder="${text(study.venue || "Lab room")}"></label>
          <label class="field wide">Note for the lab <span class="optional">(optional)</span>
            <input type="text" name="notes" placeholder="Batch A, second changeover">
          </label>
        </div>
        <div class="button-row" style="margin-top:12px">
          <button class="button secondary" type="submit">Add session</button>
        </div>
      </form>
    </div>
  `).join("");

  bindStudyButtons();
}

function bindStudyButtons() {
  $$("[data-edit-study]").forEach((b) => b.addEventListener("click", () => openStudyEditor(Number(b.dataset.editStudy))));
  $$("[data-delete-study]").forEach((b) => b.addEventListener("click", () => deleteStudy(Number(b.dataset.deleteStudy))));
  $$("[data-delete-session]").forEach((b) => b.addEventListener("click", () => deleteSession(Number(b.dataset.deleteSession))));
  $$("[data-session-status]").forEach((b) => b.addEventListener("click", () =>
    setSessionStatus(Number(b.dataset.sessionStatus), b.dataset.next)));
  $$("form.add-session").forEach((form) => form.addEventListener("submit", addSession));
  bindRosterButtons();
}

function bindRosterButtons() {
  $$("[data-roster]").forEach((b) => b.addEventListener("click", () => openRoster(Number(b.dataset.roster))));
}

function openStudyEditor(id) {
  const form = $("#study-form");
  form.reset();
  const study = cache.studies.find((s) => s.id === id);
  $("#study-modal-message").hidden = true;
  $("#study-modal-title").textContent = study ? `Edit ${study.code}` : "New study";
  form.id.value = study ? study.id : "";
  form.code.value = study ? study.code : "";
  form.code.disabled = Boolean(study);

  const fields = ["title", "summary", "piName", "rcecReference", "incentive",
                  "durationMinutes", "venue", "status", "minAge", "maxAge", "bufferPercent"];
  for (const field of fields) {
    form[field].value = study ? study[field] : (form[field].defaultValue || "");
  }
  if (!study) form.bufferPercent.value = cache.rules ? cache.rules.defaultBufferPercent : 20;
  form.requiresStudent.checked = study ? study.requiresStudent : true;
  form.declarations.value = study ? study.declarations.join("\n") : "";
  openModal("study-modal");
}

$("#new-study").addEventListener("click", () => openStudyEditor(null));

$("#study-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const body = {
    code:            form.code.value.trim(),
    title:           form.title.value.trim(),
    summary:         form.summary.value.trim(),
    piName:          form.piName.value.trim(),
    rcecReference:   form.rcecReference.value.trim(),
    incentive:       form.incentive.value.trim(),
    durationMinutes: Number(form.durationMinutes.value),
    venue:           form.venue.value.trim(),
    status:          form.status.value,
    minAge:          Number(form.minAge.value),
    maxAge:          Number(form.maxAge.value),
    requiresStudent: form.requiresStudent.checked,
    bufferPercent:   Number(form.bufferPercent.value),
    declarations:    form.declarations.value.split("\n").map((line) => line.trim()).filter(Boolean),
  };
  try {
    const id = form.id.value;
    const result = id
      ? await api(`/api/admin/studies/${id}`, { method: "PATCH", body })
      : await api("/api/admin/studies", { method: "POST", body });
    closeModal("study-modal");
    flash("success", text(result.message));
    await loadStudies();
  } catch (error) {
    flash("error", text(error.message), "#study-modal-message");
  }
});

async function deleteStudy(id) {
  const study = cache.studies.find((s) => s.id === id);
  if (!window.confirm(`Delete ${study.code}? This is only possible while nobody is booked on it.`)) return;
  try {
    flash("success", text((await api(`/api/admin/studies/${id}`, { method: "DELETE" })).message));
    await loadStudies();
  } catch (error) {
    flash("error", text(error.message));
  }
}

async function addSession(event) {
  event.preventDefault();
  const form = event.target;
  try {
    const result = await api("/api/admin/sessions", {
      method: "POST",
      body: {
        studyId:  Number(form.dataset.study),
        date:     form.date.value,
        time:     form.time.value,
        capacity: Number(form.capacity.value),
        location: form.location.value.trim(),
        notes:    form.notes.value.trim(),
      },
    });
    flash("success", text(result.message));
    await loadStudies();
  } catch (error) {
    flash("error", text(error.message));
  }
}

async function setSessionStatus(id, status) {
  if (status === "cancelled" && !window.confirm(
    "Cancel this session? Anybody already booked keeps their seat in the record, so contact them yourself and either rebook or release them.")) return;
  try {
    flash("info", text((await api(`/api/admin/sessions/${id}`, { method: "PATCH", body: { status } })).message));
    await loadStudies();
  } catch (error) {
    flash("error", text(error.message));
  }
}

async function deleteSession(id) {
  if (!window.confirm("Delete this session? This is only possible while nobody is booked on it.")) return;
  try {
    flash("success", text((await api(`/api/admin/sessions/${id}`, { method: "DELETE" })).message));
    await loadStudies();
  } catch (error) {
    flash("error", text(error.message));
  }
}

// ---------------------------------------------------------------------------
// Roster and attendance
// ---------------------------------------------------------------------------

const ATTENDANCE = [
  ["booked",        "Booked, not yet seen"],
  ["attended",      "Attended"],
  ["late_admitted", "Attended, admitted late"],
  ["no_show",       "No-show, unexplained"],
  ["cancelled",     "Cancelled in advance"],
  ["turned_away",   "Turned away, session full"],
  ["withdrawn",     "Withdrew during the session"],
];

async function openRoster(sessionId) {
  openModal("roster-modal");
  $("#roster-message").hidden = true;
  $("#roster-body").innerHTML = `<p class="loading">Loading.</p>`;
  const data = await api(`/api/admin/sessions/${sessionId}/roster`);

  $("#roster-title").textContent = `${data.session.studyCode} ${data.session.studyTitle}`;
  $("#roster-meta").textContent =
    `${data.session.label}. ${data.session.location || "Location not set"}. Room capacity ${data.session.capacity}. Ethics approval ${data.session.rcecReference || "not recorded"}.`;
  $("#roster-csv").href = `/api/admin/sessions/${sessionId}/roster.csv`;

  if (data.roster.length === 0) {
    $("#roster-body").innerHTML = `<p class="field-note" style="margin:0">Nobody has booked this session yet.</p>`;
    return;
  }

  $("#roster-body").innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Participant</th><th>Contact</th><th class="numeric">Age</th>
      <th>Institution</th><th>Standing</th><th>Attendance</th>
    </tr></thead>
    <tbody>${data.roster.map((r) => `
      <tr>
        <td><strong>${text(r.code)}</strong><br>${text(r.name)}</td>
        <td>${text(r.phone)}<br><small>${text(r.email)}</small></td>
        <td class="numeric">${text(r.age)}</td>
        <td>${text(r.institution)}</td>
        <td>
          <span class="pill ${r.poolStatus === "active" ? "good" : "bad"}">${text(r.poolStatus)}</span>
          ${r.noShowCount > 0 ? `<br><small>${text(r.noShowCount)} prior no-show${r.noShowCount === 1 ? "" : "s"}</small>` : ""}
        </td>
        <td>
          <select data-booking="${r.bookingId}">
            ${ATTENDANCE.map(([value, label]) =>
              `<option value="${value}" ${value === r.status ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </td>
      </tr>`).join("")}
    </tbody></table></div>
    <p class="field-note" style="margin-top:12px">
      Record a no-show only where the participant did not tell the lab in advance. Somebody who
      cancelled, or who called to say they were ill, is <strong>cancelled in advance</strong> and it
      does not count against them.
    </p>`;

  $$("[data-booking]").forEach((select) => {
    select.addEventListener("change", () => markAttendance(Number(select.dataset.booking), select.value, sessionId));
  });
}

async function markAttendance(bookingId, status, sessionId) {
  try {
    const result = await api(`/api/admin/bookings/${bookingId}`, { method: "PATCH", body: { status } });
    flash(result.standing?.status === "suspended" ? "warn" : "success", text(result.message), "#roster-message");
    if (result.standing?.status === "suspended") await openRoster(sessionId);
  } catch (error) {
    flash("error", text(error.message), "#roster-message");
  }
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

async function loadParticipants() {
  cache.participants = await api("/api/admin/participants");
  $("#participants-table").classList.remove("loading");
  renderParticipants();
}

$("#participant-search").addEventListener("input", renderParticipants);

function renderParticipants() {
  const query = $("#participant-search").value.trim().toLowerCase();
  const rows = cache.participants.filter((p) => !query || [
    p.code, p.name, p.email, p.phone, p.institution, p.department,
  ].join(" ").toLowerCase().includes(query));

  const container = $("#participants-table");
  if (rows.length === 0) {
    container.innerHTML = `<div class="card"><p style="margin:0">No participant matches that search.</p></div>`;
    return;
  }
  const tone = { active: "good", suspended: "bad", withdrawn: "quiet" };
  container.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Code</th><th>Name</th><th>Contact</th><th class="numeric">Age</th>
      <th>Institution</th><th>Standing</th><th class="numeric">Sat</th>
      <th class="numeric">No-shows</th><th>Last session</th><th></th>
    </tr></thead>
    <tbody>${rows.map((p) => `
      <tr>
        <td><strong>${text(p.code)}</strong></td>
        <td>${text(p.name)}${p.erasedAt ? `<br><small>Erased</small>` : ""}</td>
        <td>${text(p.phone)}<br><small>${text(p.email)}</small></td>
        <td class="numeric">${text(p.age)}</td>
        <td>${text(p.institution)}</td>
        <td><span class="pill ${tone[p.status]}">${text(p.status)}</span></td>
        <td class="numeric">${text(p.participatedCount)}</td>
        <td class="numeric">${text(p.noShowCount)}</td>
        <td>${text(p.lastParticipationLabel || "None")}</td>
        <td><button class="button small secondary" data-participant="${p.id}">Open</button></td>
      </tr>`).join("")}
    </tbody></table></div>
    <p class="field-note" style="margin-top:12px">${rows.length} of ${cache.participants.length} records shown.</p>`;

  $$("[data-participant]").forEach((b) =>
    b.addEventListener("click", () => openParticipant(Number(b.dataset.participant))));
}

function openParticipant(id) {
  const p = cache.participants.find((x) => x.id === id);
  $("#participant-title").textContent = `${p.code}, ${p.name}`;
  $("#participant-message").hidden = true;
  $("#participant-body").innerHTML = `
    <dl class="dl">
      <dt>Email</dt><dd>${text(p.email)}</dd>
      <dt>Mobile</dt><dd>${text(p.phone)}</dd>
      <dt>Age</dt><dd>${text(p.age)} (from year of birth ${text(p.yearOfBirth)})</dd>
      <dt>Gender</dt><dd>${text(p.gender || "Not given")}</dd>
      <dt>Student</dt><dd>${p.isStudent ? "Yes" : "No"}</dd>
      <dt>Institution</dt><dd>${text(p.institution || "Not given")}</dd>
      <dt>Course</dt><dd>${text([p.department, p.programme, p.yearOfStudy].filter(Boolean).join(", ") || "Not given")}</dd>
      <dt>Languages</dt><dd>${text(p.languages.join(", ") || "Not given")}</dd>
      <dt>Heard via</dt><dd>${text(p.howHeard || "Not given")}</dd>
      <dt>Consent</dt><dd>${text(p.consentVersion || "Not recorded")}</dd>
      <dt>Sessions sat</dt><dd>${text(p.participatedCount)}</dd>
      <dt>No-shows</dt><dd>${text(p.noShowCount)}</dd>
      <dt>Last session</dt><dd>${text(p.lastParticipationLabel || "None")}</dd>
      ${p.suspensionReason ? `<dt>Note</dt><dd>${text(p.suspensionReason)}</dd>` : ""}
    </dl>

    <h3>Pool standing</h3>
    <form id="standing-form">
      <div class="form-grid">
        <label class="field">Standing
          <select name="status">
            <option value="active" ${p.status === "active" ? "selected" : ""}>Active</option>
            <option value="suspended" ${p.status === "suspended" ? "selected" : ""}>Paused</option>
            <option value="withdrawn" ${p.status === "withdrawn" ? "selected" : ""}>Withdrawn</option>
          </select>
        </label>
        <label class="field">Paused until
          <input type="date" name="suspendedUntil" value="${p.suspendedUntil ? String(p.suspendedUntil).slice(0, 10) : ""}">
        </label>
        <label class="field wide">Reason, for the lab's record
          <input type="text" name="reason" value="${text(p.suspensionReason)}">
        </label>
        <div class="wide">
          <label class="check">
            <input type="checkbox" name="resetNoShows">
            <span>Reset the no-show count to zero. Use this when an appeal succeeds.</span>
          </label>
        </div>
      </div>
      <div class="button-row" style="margin-top:14px">
        <button class="button primary" type="submit">Save standing</button>
        <button class="button danger" type="button" id="erase-participant" ${p.erasedAt ? "disabled" : ""}>
          ${p.erasedAt ? "Already erased" : "Erase personal data"}
        </button>
      </div>
    </form>
    <p class="field-note" style="margin-top:12px">
      Erasing clears the name, contact details and demographics and cannot be undone. The record
      that this participant reference attended a session is kept, so the lab can still account for
      the sessions it ran and the payments it made.
    </p>`;

  $("#standing-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const result = await api(`/api/admin/participants/${id}`, {
        method: "PATCH",
        body: {
          status:         form.status.value,
          suspendedUntil: form.suspendedUntil.value || null,
          reason:         form.reason.value.trim(),
          resetNoShows:   form.resetNoShows.checked,
        },
      });
      flash("success", text(result.message), "#participant-message");
      await loadParticipants();
    } catch (error) {
      flash("error", text(error.message), "#participant-message");
    }
  });

  $("#erase-participant").addEventListener("click", async () => {
    if (!window.confirm(`Erase the personal data held for ${p.code}? This cannot be undone.`)) return;
    try {
      const result = await api(`/api/admin/participants/${id}/erase`, { method: "POST" });
      flash("success", text(result.message), "#participant-message");
      await loadParticipants();
    } catch (error) {
      flash("error", text(error.message), "#participant-message");
    }
  });

  openModal("participant-modal");
}

// ---------------------------------------------------------------------------
// Rules and activity
// ---------------------------------------------------------------------------

async function loadRules() {
  const rules = await api("/api/admin/rules");
  cache.rules = rules;
  const form = $("#rules-form");
  form.minDaysBetweenStudies.value   = rules.minDaysBetweenStudies;
  form.noShowsBeforeSuspension.value = rules.noShowsBeforeSuspension;
  form.suspensionDays.value          = rules.suspensionDays;
  form.defaultBufferPercent.value    = rules.defaultBufferPercent;
  form.consentVersion.value          = rules.consentVersion;
  form.poolOpen.checked              = rules.poolOpen;
}

$("#rules-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    const result = await api("/api/admin/rules", {
      method: "PATCH",
      body: {
        minDaysBetweenStudies:   Number(form.minDaysBetweenStudies.value),
        noShowsBeforeSuspension: Number(form.noShowsBeforeSuspension.value),
        suspensionDays:          Number(form.suspensionDays.value),
        defaultBufferPercent:    Number(form.defaultBufferPercent.value),
        poolOpen:                form.poolOpen.checked,
        consentVersion:          form.consentVersion.value.trim(),
      },
    });
    cache.rules = result.rules;
    flash("success", text(result.message));
  } catch (error) {
    flash("error", text(error.message));
  }
});

async function loadActivity() {
  const rows = await api("/api/admin/activity");
  const container = $("#activity-table");
  container.classList.remove("loading");
  container.innerHTML = rows.length === 0
    ? `<div class="card"><p style="margin:0">Nothing recorded yet.</p></div>`
    : `<div class="table-wrap"><table>
        <thead><tr><th>When (IST)</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr><td>${text(r.at)}</td><td>${text(r.action)}</td><td>${text(r.detail)}</td></tr>
        `).join("")}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$("#refresh-overview").addEventListener("click", loadOverview);
$("#refresh-activity").addEventListener("click", loadActivity);
$("#signout").addEventListener("click", async (event) => {
  event.preventDefault();
  await fetch("/api/admin/logout", { method: "POST" });
  window.location.href = "/admin-login";
});

api("/api/admin/session").then((data) => {
  if (!data.signedIn) window.location.href = "/admin-login";
  else loadOverview();
});
