
const config = {
    NUMBER: process.env.NUMBER || '923072380380',
SESSION_ID: process.env.SESSION_ID === undefined ? 'Byte;;;=' : process.env.SESSION_ID,
    USE_RANDOM_DELAY: process.env.USE_RANDOM_DELAY || 'false', 
    RANDOM_DELAY_RANGE: process.env.RANDOM_DELAY_RANGE || '10,20', 
    DELAY_TIME: process.env.DELAY_TIME || '10' 
};
module.exports = config;