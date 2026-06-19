const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');

async function getActivityList() {
    const body = types.GetActivityListRequest.encode(types.GetActivityListRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', body);
    const reply = types.GetActivityListReply.decode(replyBody);
    return {
        activityCount: Array.isArray(reply.activities) ? reply.activities.length : 0,
        redDotCount: Array.isArray(reply.red_dots) ? reply.red_dots.length : 0,
    };
}

async function getActivityGroup(groupId) {
    const safeGroupId = Number(groupId) || 0;
    if (!safeGroupId) {
        throw new Error('Missing activity group id');
    }
    const body = types.GetActivityGroupRequest.encode(types.GetActivityGroupRequest.create({
        group_id: safeGroupId,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', body);
    const reply = types.GetActivityGroupReply.decode(replyBody);
    return {
        groupId: safeGroupId,
        payloadLength: toNum(reply && reply.group && reply.group.length),
    };
}

module.exports = {
    getActivityList,
    getActivityGroup,
};
