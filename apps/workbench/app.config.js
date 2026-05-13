const { version } = require("./package.json");

const relayUrl = process.env.EXPO_PUBLIC_RELAY_URL || "http://127.0.0.1:8791";
const workbenchOrigin =
  process.env.EXPO_PUBLIC_WORKBENCH_ORIGIN || "http://127.0.0.1:8790";

module.exports = {
  expo: {
    name: "Free Workbench",
    slug: "free-workbench",
    version,
    scheme: "free-workbench",
    orientation: "default",
    userInterfaceStyle: "light",
    icon: "./assets/images/icon.png",
    ios: {
      supportsTablet: true,
      bundleIdentifier: "app.saaskit.free.workbench",
    },
    android: {
      package: "app.saaskit.free.workbench",
      adaptiveIcon: {
        foregroundImage: "./assets/images/icon-adaptive.png",
        monochromeImage: "./assets/images/icon-monochrome.png",
        backgroundColor: "#101014",
      },
    },
    web: {
      bundler: "metro",
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    extra: {
      relayUrl,
      workbenchOrigin,
    },
  },
};
