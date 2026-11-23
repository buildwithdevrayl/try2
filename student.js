/* =========================================
   CLASSROOMRESERVE - STUDENT PORTAL
   View only: students check whether a room is free
   and which instructor reserved it. No sign-in.
========================================= */

/* PASTE YOUR WEB APP URL HERE (Apps Script > Deploy > Manage deployments >
   Web app URL, ending in /exec). The student page reads the database
   through this address. Use the same URL as the admin and instructor pages. */
const API_URL = "https://script.google.com/macros/s/AKfycbyxrdkkAAmclfl4RZDhYD6Ep6MJNlCDQQXsRsMe1_s9D6zmIreMRYXVdd7BxOgS3MmM8A/exec";

const OPEN_HOUR = 7;      // 7:00 AM
const CLOSE_HOUR = 21;    // 9:00 PM
const TOTAL_HOURS = CLOSE_HOUR - OPEN_HOUR;
const REFRESH_MS = 60000;

const $ = id => document.getElementById(id);

let rooms = [];
let bookings = [];          // confirmed reservations only
let roomId = "";
let viewMonth = firstOfMonth(new Date());
let selectedDate = localToday();
let loading = false;

/* ---------- date / time helpers ---------- */

function pad2(n) { return String(n).padStart(2, "0"); }

function iso(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localToday() { return iso(new Date()); }

function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function fromISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function normDate(v) {
    if (!v) return "";
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return isNaN(d) ? s : iso(d);
}

function normTime(v) {
    if (v === null || v === undefined || v === "") return "";
    const s = String(v).trim();

    let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
    if (m) {
        let h = Number(m[1]) % 12;
        if (m[3].toUpperCase() === "PM") h += 12;
        return `${pad2(h)}:${m[2]}`;
    }

    m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m) return `${pad2(m[1])}:${m[2]}`;

    const d = new Date(s);
    if (isNaN(d)) return s;

    let h = d.getHours(), min = d.getMinutes();
    if (d.getFullYear() < 1950) {
        // Sheets time-only cells carry a 1899 offset; snap to 5 minutes
        const total = Math.round((h * 60 + min) / 5) * 5;
        h = Math.floor(total / 60) % 24;
        min = total % 60;
    }
    return `${pad2(h)}:${pad2(min)}`;
}

function clock(hour) {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
}

function clockText(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    const d = new Date();
    d.setHours(h || 0, m || 0, 0, 0);
    return d.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
}

function longDate(s) {
    return fromISO(s).toLocaleDateString([], {weekday: "long", year: "numeric", month: "long", day: "numeric"});
}

const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

/* ---------- loading ---------- */

/* Read-only requests to the SAME Apps Script (Code.gs) as the admin and
   instructor portals. These two actions need no sign-in:
     publicRooms     -> active classrooms
     publicSchedule  -> confirmed reservations between two dates          */
async function callApi(action, params = {}) {
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(API_URL)) {
        throw new Error("The web app URL is not set in student.js.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
        const query = new URLSearchParams({action, ...params});
        const response = await fetch(`${API_URL}?${query}`, {signal: controller.signal});
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

/* reservations are loaded one month at a time (the server allows 62 days) */
const monthCache = {};

function monthKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

function monthRange(key) {
    const [y, m] = key.split("-").map(Number);
    return {from: `${key}-01`, to: `${key}-${pad2(new Date(y, m, 0).getDate())}`};
}

function rebuildBookings() {
    bookings = Object.values(monthCache).flat();
}

async function loadMonth(key) {
    const {from, to} = monthRange(key);
    const data = await callApi("publicSchedule", {from, to});

    if (!data || !data.success) {
        throw new Error((data && data.message) || "The room schedule could not be loaded.");
    }

    monthCache[key] = (data.reservations || []).map(r => ({
        RoomID: String(r.RoomID),
        Date: normDate(r.Date),
        Start: normTime(r.StartTime),
        End: normTime(r.EndTime),
        Instructor: String(r.InstructorName || "").trim(),
        Subject: String(r.Subject || "").trim()
    })).filter(r => r.Start && r.End);

    rebuildBookings();
}

function showNotice(message) {
    $("notice").textContent = message;
    $("notice").classList.remove("hidden");
}

function hideNotice() { $("notice").classList.add("hidden"); }

async function load(silent = false) {
    if (loading) return;
    loading = true;
    if (!silent) $("refreshBtn").classList.add("spin");

    try {
        const roomData = await callApi("publicRooms");

        if (!roomData || !roomData.success) {
            throw new Error((roomData && roomData.message) || "The classrooms could not be loaded.");
        }

        rooms = (roomData.rooms || [])
            .sort((a, b) => String(a.Building).localeCompare(String(b.Building)) ||
                            String(a.RoomName).localeCompare(String(b.RoomName), undefined, {numeric: true}));

        // refresh the month on screen and the month of the chosen day
        const keys = [...new Set([monthKey(viewMonth), selectedDate.slice(0, 7)])];
        await Promise.all(keys.map(loadMonth));

        hideNotice();
        renderRoomSelect();
        renderAll();
        $("updatedAt").textContent = "Last updated " +
            new Date().toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});

    } catch (error) {
        console.warn("Student schedule error:", error.message);

        if (!silent || !rooms.length) {
            showNotice(error.name === "AbortError"
                ? "The server is taking too long. Please try again."
                : /not set in student\.js/.test(error.message) ? error.message
                : (error.message === "Failed to fetch"
                    ? "Connection problem. Check your internet and try again."
                    : "The room schedule can't be loaded right now. Please try again in a few minutes."));
        }
    } finally {
        loading = false;
        $("refreshBtn").classList.remove("spin");
    }
}

/* load a month the student navigated to */
async function ensureMonth() {
    const key = monthKey(viewMonth);
    if (monthCache[key]) return;

    try {
        await loadMonth(key);
        hideNotice();
    } catch (error) {
        showNotice("This month's schedule can't be loaded right now. Please try again.");
    }

    renderMonth();
    renderDay();
}

/* ---------- availability maths ---------- */

/* An hour [h, h+1) is reserved when any booking overlaps it */
function hourBooked(room, date, hour) {
    const start = `${pad2(hour)}:00`;
    const end = `${pad2(hour + 1)}:00`;
    return bookings.some(b =>
        b.RoomID === room && b.Date === date && start < b.End && end > b.Start
    );
}

/* The booking (if any) that covers a given hour */
function bookingAt(room, date, hour) {
    const start = `${pad2(hour)}:00`;
    const end = `${pad2(hour + 1)}:00`;
    return bookings.find(b =>
        b.RoomID === room && b.Date === date && start < b.End && end > b.Start
    );
}

function reservedHours(room, date) {
    let n = 0;
    for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) if (hourBooked(room, date, h)) n++;
    return n;
}

/* Hours that have already gone by today */
function hourPassed(date, hour) {
    const today = localToday();
    if (date < today) return true;
    if (date > today) return false;
    const now = new Date();
    return hour + 1 <= now.getHours() + now.getMinutes() / 60;
}

/* A booking is COMPLETE once its end time has gone by */
function bookingDone(b) {
    const today = localToday();
    if (b.Date < today) return true;
    if (b.Date > today) return false;
    const now = new Date();
    return b.End <= `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/* ---------- rendering ---------- */

function renderRoomSelect() {
    const select = $("roomSelect");

    if (!rooms.length) {
        select.innerHTML = `<option>No classrooms available</option>`;
        select.disabled = true;
        $("roomInfo").classList.add("hidden");
        return;
    }

    const byBuilding = {};
    rooms.forEach(r => (byBuilding[r.Building || "Other"] ||= []).push(r));

    select.innerHTML = Object.entries(byBuilding).map(([building, list]) => `
        <optgroup label="${esc(building)}">
            ${list.map(r => `<option value="${esc(r.RoomID)}">${esc(r.RoomName)}</option>`).join("")}
        </optgroup>`).join("");

    select.disabled = false;

    // keep the room the student already chose
    if (!rooms.some(r => String(r.RoomID) === roomId)) roomId = String(rooms[0].RoomID);
    select.value = roomId;
}

function renderRoomInfo() {
    const room = rooms.find(r => String(r.RoomID) === roomId);
    const box = $("roomInfo");

    if (!room) { box.classList.add("hidden"); return; }

    const bits = [];
    if (room.Building) bits.push(esc(room.Building));
    if (room.Floor) bits.push(esc(room.Floor));
    if (room.Capacity) bits.push(`Seats ${esc(room.Capacity)}`);

    const photo = room.PhotoURL
        ? `<img src="${esc(room.PhotoURL)}" alt="" loading="lazy" onerror="this.remove()">`
        : "";

    box.innerHTML = `
        ${photo}
        <div>
            <p><strong>${esc(room.RoomName)}</strong> · ${bits.join(" · ")}</p>
            ${room.Facilities ? `<p>${esc(room.Facilities)}</p>` : ""}
        </div>`;
    box.classList.remove("hidden");
}

function renderMonth() {
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth();
    const today = localToday();

    $("monthTitle").textContent = viewMonth.toLocaleDateString([], {month: "long", year: "numeric"});

    const lead = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < lead; i++) cells.push(`<span class="s-day-cell blank"></span>`);

    for (let d = 1; d <= days; d++) {
        const date = `${y}-${pad2(m + 1)}-${pad2(d)}`;
        const used = roomId ? reservedHours(roomId, date) : 0;
        const past = date < today;

        const ready = !!monthCache[monthKey(viewMonth)];
        const state = !ready ? "loading" : past ? "past" : used === 0 ? "free" : used >= TOTAL_HOURS ? "full" : "part";
        const label = !ready ? "loading" : past ? "passed"
            : used === 0 ? "free all day"
            : used >= TOTAL_HOURS ? "fully reserved"
            : `${TOTAL_HOURS - used} of ${TOTAL_HOURS} hours free`;

        cells.push(`
            <button type="button" role="gridcell"
                class="s-day-cell ${state} ${date === today ? "today" : ""} ${date === selectedDate ? "selected" : ""}"
                data-date="${date}"
                aria-label="${esc(longDate(date))}, ${label}"
                aria-pressed="${date === selectedDate}">
                <span>${d}</span>
                <span class="s-fill"><b style="width:${Math.round(used / TOTAL_HOURS * 100)}%"></b></span>
            </button>`);
    }

    $("monthGrid").innerHTML = cells.join("");
}

function renderDay() {
    const room = rooms.find(r => String(r.RoomID) === roomId);

    if (!room || !selectedDate) {
        $("dayTitle").textContent = "Select a date";
        $("daySummary").textContent = "";
        $("freeRanges").textContent = "";
        $("bookedList").innerHTML = "";
        $("slotGrid").innerHTML = "";
        return;
    }

    $("dayTitle").textContent = longDate(selectedDate);

    const slots = [];
    let freeCount = 0;
    const freeHours = [];

    for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
        const booked = hourBooked(roomId, selectedDate, h);
        const passed = !booked && hourPassed(selectedDate, h);
        const done = booked && hourPassed(selectedDate, h);

        if (!booked && !passed) { freeCount++; freeHours.push(h); }

        const bk = booked ? (bookingAt(roomId, selectedDate, h) || {}) : {};
        const who = bk.Instructor;
        const subj = bk.Subject;

        slots.push(`
            <div class="s-slot ${booked ? (done ? "reserved done" : "reserved") : passed ? "passed" : ""}">
                <div class="s-slot-l">
                    <span class="s-slot-time">${clock(h)} - ${clock(h + 1)}</span>
                    <em class="s-state">${booked ? (done ? "✓ Completed" : "Reserved") : passed ? "Passed" : "Free"}</em>
                </div>
                ${who || subj ? `<div class="s-slot-r">
                    ${who ? `<small>Instructor: ${esc(who)}</small>` : ""}
                    ${subj ? `<small>Subject: ${esc(subj)}</small>` : ""}
                </div>` : ""}
            </div>`);
    }

    $("slotGrid").innerHTML = slots.join("");
    $("daySummary").textContent = `${room.RoomName} · open ${clock(OPEN_HOUR)} to ${clock(CLOSE_HOUR)}`;

    // join consecutive free hours: "8:00 AM - 11:00 AM, 1:00 PM - 6:00 PM"
    const ranges = [];
    freeHours.forEach(h => {
        const last = ranges[ranges.length - 1];
        if (last && last.end === h) last.end = h + 1;
        else ranges.push({start: h, end: h + 1});
    });

    // who booked the room, with the exact times
    const day = bookings
        .filter(b => b.RoomID === roomId && b.Date === selectedDate)
        .sort((a, b) => a.Start.localeCompare(b.Start));

    $("bookedList").innerHTML = day.length ? `
        <h3>Reservations</h3>
        <ul>${day.map(b => `
            <li class="${bookingDone(b) ? "done" : ""}">
                <span class="s-when">${esc(clockText(b.Start))} - ${esc(clockText(b.End))}${bookingDone(b) ? `<em class="s-done">✓ Completed</em>` : ""}</span>
                <span class="s-who">
                    ${b.Instructor ? `<small>Instructor: ${esc(b.Instructor)}</small>` : "Reserved"}
                    ${b.Subject ? `<small>Subject: ${esc(b.Subject)}</small>` : ""}
                </span>
            </li>`).join("")}
        </ul>` : "";

    const box = $("freeRanges");
    if (ranges.length) {
        box.className = "s-free";
        box.textContent = "Free: " + ranges.map(r => `${clock(r.start)} - ${clock(r.end)}`).join(", ");
    } else {
        box.className = "s-free none";
        box.textContent = selectedDate < localToday()
            ? "This day has already passed."
            : "No free hours on this day.";
    }
}

function renderAll() {
    renderRoomInfo();
    renderMonth();
    renderDay();
}

/* ---------- events ---------- */

$("roomSelect").addEventListener("change", e => {
    roomId = e.target.value;
    renderAll();
});

$("monthGrid").addEventListener("click", e => {
    const cell = e.target.closest("[data-date]");
    if (!cell) return;
    selectedDate = cell.dataset.date;
    renderMonth();
    renderDay();

    // on phones, bring the hours into view
    if (window.matchMedia("(max-width: 900px)").matches) {
        $("dayTitle").scrollIntoView({behavior: "smooth", block: "start"});
    }
});

$("prevMonth").onclick = () => {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
    renderMonth();
    ensureMonth();
};

$("nextMonth").onclick = () => {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
    renderMonth();
    ensureMonth();
};

$("todayBtn").onclick = () => {
    selectedDate = localToday();
    viewMonth = firstOfMonth(new Date());
    renderMonth();
    renderDay();
    ensureMonth();
};

$("refreshBtn").onclick = () => load(false);

/* keep the schedule fresh without the student doing anything */
setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });
window.addEventListener("online", () => load(true));

load();