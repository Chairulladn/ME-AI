async function sendText(sock, from, text) {
    let remaining = String(text);
    while (remaining.length > 3500) {
        let boundary = Math.max(remaining.lastIndexOf('\n', 3500), remaining.lastIndexOf(' ', 3500));
        if (boundary < 1750) boundary = 3500;
        // Never split a UTF-16 surrogate pair.
        if (/[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
        await sock.sendMessage(from, { text: remaining.slice(0, boundary) });
        remaining = remaining.slice(boundary);
    }
    if (remaining) await sock.sendMessage(from, { text: remaining });
}
module.exports = { sendText };
