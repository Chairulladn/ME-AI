const { spawn } = require("node:child_process");
const { checkOwner } = require("../core/database");
const { assertActive } = require("../core/jobs");
const OWNER_ONLY_MSG = "🚩 Access Denied.";

function runPm2(action) {
    return new Promise((resolve, reject) => {
        // Do not await PM2 stopping this very process: shutdown drains the queue.
        const child = spawn("pm2", [action, "ME-AI"], { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
    });
}

async function handleProblem(sock, from) {
    await sock.sendMessage(from, { text: "kalo ada problem chat nomor ini 🥱" });
    await sock.sendPresenceUpdate("composing", from);
    await sock.sendMessage(from, {
        contacts: {
            displayName: "Me",
            contacts: [{
                displayName: "Me",
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Chairul\nTEL;type=CELL;type=VOICE;waid=6282258868276:6282258868276\nEND:VCARD",
            }],
        },
    });
}

async function handleOff(sock, from, senderNumber) {
    if (!checkOwner(senderNumber)) {
        await sock.sendMessage(from, { text: OWNER_ONLY_MSG });
        return;
    }
    await sock.sendMessage(from, { text: "🔱 Mematikan bot..." });
    await runPm2("stop");
}

async function handleRestart(sock, from, senderNumber) {
    if (!checkOwner(senderNumber)) {
        await sock.sendMessage(from, { text: OWNER_ONLY_MSG });
        return;
    }
    await sock.sendMessage(from, { text: "🔄 Restarting bot..." });
    await runPm2("restart");
}

async function handleStats(sock, from, senderNumber, db) {
    if (!checkOwner(senderNumber)) {
        await sock.sendMessage(from, { text: OWNER_ONLY_MSG });
        return;
    }

    await sock.sendPresenceUpdate("composing", from);

    const totalUsers = Object.keys(db.users).length;
    const totalChat = Object.values(db.users).reduce((total, user) => total + (user.chat || 0), 0);
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const ram = Math.round(process.memoryUsage().rss / 1024 / 1024);

    await sock.sendMessage(from, {
        text: `📊 ME - AI DASHBOARD

👥 Total User : ${totalUsers}
💬 Total Chat : ${totalChat}

🧠 RAM :
${ram} MB

⚡ Uptime :
${hours} Jam
${minutes} Menit
${seconds} Detik`,
    });
}

async function handleResetdb(sock, from, senderNumber, saveDatabase, db) {
    if (!checkOwner(senderNumber)) {
        await sock.sendMessage(from, { text: OWNER_ONLY_MSG });
        return;
    }
    const previous = db.users;
    db.users = {};
    try { await saveDatabase(db); }
    catch (error) { assertActive(); db.users = previous; throw error; }
    await sock.sendMessage(from, { text: "⚡ Database Successfully Reset" });
}

module.exports = {
    handleProblem,
    handleOff,
    handleRestart,
    handleStats,
    handleResetdb,
};
