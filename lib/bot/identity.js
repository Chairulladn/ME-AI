function phoneNumber(jid) {
    if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
    const number = jid.split('@')[0].split(':')[0];
    return /^\d+$/.test(number) ? number : null;
}
async function resolveSenderNumber(sock, msg) {
    const primary = msg.key.participant || msg.key.remoteJid;
    const number = phoneNumber(primary);
    if (number) return number;
    if (!primary?.endsWith('@lid')) return null;
    const mapping = sock.signalRepository?.lidMapping;
    const mapped = await mapping?.getPNForLID(primary);
    const mappedNumber = phoneNumber(mapped);
    if (mappedNumber) return mappedNumber;
    // These alternates are supplied by Baileys from WhatsApp transport metadata,
    // never from message text, contacts or pushName.
    const alternate = msg.key.participant ? msg.key.participantAlt : msg.key.remoteJidAlt;
    return phoneNumber(alternate);
}
module.exports = { resolveSenderNumber };
