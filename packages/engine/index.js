"use strict";
module.exports = {
  ...require("./config"), ...require("./curve"), ...require("./market"),
  ...require("./npc"), ...require("./orders"), ...require("./invariants"),
  ...require("./snapshot"), ...require("./room"),
  // Переходник для старого интерфейса (app/src/MarketSandbox.jsx).
  // Room и обычный CONFIG (без .market) намеренно НЕ трогаем — от них
  // зависит server/ и app.js. LegacyRoom экспортируется отдельным именем,
  // а CONFIG здесь дополняется полем .market (ничего не удаляется).
  ...require("./legacyRoom"),
};
