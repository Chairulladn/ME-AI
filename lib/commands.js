const { exec } = require("child_process");
const { checkOwner } = require("./database");

const OWNER_ONLY_MSG = "🚩 Access Denied.";

function runPm2(command) {
    return new Promise((resolve) => {
        exec(command, (err, stdout) => {
            if (err) console.error("[commands] pm2 error:", err.message);
            else console.log(stdout);
            resolve();
        });
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
    await runPm2("pm2 stop ME-AI && pm2 list");
}

async function handleRestart(sock, from, senderNumber) {
    if (!checkOwner(senderNumber)) {
        await sock.sendMessage(from, { text: OWNER_ONLY_MSG });
        return;
    }
    await sock.sendMessage(from, { text: "🔄 Restarting bot..." });
    await runPm2("pm2 restart ME-AI && pm2 list");
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

async function handleResetdb(sock, from, senderNumber, saveDatabase) {
    if (!checkOwner(senderNumber)) {
        await sock.sendMessage(from, { text: OWNER_ONLY_MSG });
        return;
    }
    const db = { users: {} };
    saveDatabase(db);
    await sock.sendMessage(from, { text: "⚡ Database Successfully Reset" });
    setTimeout(() => process.exit(), 3000);
}

module.exports = {
    handleProblem,
    handleOff,
    handleRestart,
    handleStats,
    handleResetdb,
};
