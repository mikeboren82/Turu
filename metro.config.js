const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// tools/import-tool הוא שרת Node/Express נפרד (כלי הניהול) עם node_modules משלו - לא חלק
// מאפליקציית ה-Expo. בלי ההחרגה הזו, Metro סורק גם אותו וטובע במודולי-Node (כמו 'path' ב-
// server.js) שלא ניתנים ל-resolve בבאנדל של React Native. blockList מקבל RegExp | RegExp[]
// ישירות (לא דרך metro-config/src/defaults/exclusionList - subpath לא חשוף ב-package.json
// exports של metro-config, נכשל עם ERR_PACKAGE_PATH_NOT_EXPORTED).
const existingBlockList = config.resolver.blockList
  ? (Array.isArray(config.resolver.blockList) ? config.resolver.blockList : [config.resolver.blockList])
  : [];
config.resolver.blockList = [...existingBlockList, /tools[\\/]import-tool[\\/].*/];

module.exports = config;
