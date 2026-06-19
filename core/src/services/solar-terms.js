const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');

const CURRENT_SOLAR_TERM_ID = 101;

function normalizeSolarTerms(reply) {
    return {
        serverTime: toNum(reply && reply.server_time),
        termCount: Array.isArray(reply && reply.terms) ? reply.terms.length : 0,
        hasActivityPayload: !!(reply && reply.activity && reply.activity.length),
        currentSolarTermId: CURRENT_SOLAR_TERM_ID,
    };
}

async function getSolarTerms() {
    const body = types.GetSolarTermsRequest.encode(types.GetSolarTermsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'GetSolarTerms', body);
    return normalizeSolarTerms(types.GetSolarTermsReply.decode(replyBody));
}

async function claimSolarTerms(solarTermId = CURRENT_SOLAR_TERM_ID) {
    const safeSolarTermId = Number(solarTermId) || CURRENT_SOLAR_TERM_ID;
    const body = types.ClaimSolarTermsRequest.encode(types.ClaimSolarTermsRequest.create({
        solar_term_id: safeSolarTermId,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'ClaimSolarTerms', body);
    const reply = types.ClaimSolarTermsReply.decode(replyBody);
    return {
        solarTermId: safeSolarTermId,
        rewardCount: Array.isArray(reply.rewards) ? reply.rewards.length : 0,
        hasTermPayload: !!(reply.term && reply.term.length),
    };
}

module.exports = {
    CURRENT_SOLAR_TERM_ID,
    getSolarTerms,
    claimSolarTerms,
};
