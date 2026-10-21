function activityLogType() {
  return [
    { id: 0, title: "other" },
    { id: 1, title: "auth" },
    { id: 2, title: "user" },
    { id: 7, title: "setting" },
    { id: 9, title: "homepage" },
    { id: 10, title: "customer" },
    { id: 11, title: "business" },
    { id: 12, title: "coin" },
  ];
}

module.exports = {
  activityLogType,
};
