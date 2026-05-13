import { StyleSheet } from "react-native";

export const colors = {
  ink: "#101014",
  graphite: "#25242C",
  muted: "#686676",
  paper: "#FFFDF7",
  line: "#E7E1D4",
  lime: "#D8FF3E",
  coral: "#FF5C35",
  cyan: "#00C9FF",
  violet: "#7C4DFF",
  green: "#27C777",
  rose: "#FF4FA3",
};

export const typography = {
  display: "BricolageGrotesqueBold",
  sans: "IBMPlexSans",
  sansSemi: "IBMPlexSansSemiBold",
  mono: "IBMPlexMono",
};

export const common = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  panel: {
    borderWidth: 1,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: "#FFFFFF",
    shadowColor: colors.ink,
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: 5, height: 5 },
  },
  eyebrow: {
    color: colors.muted,
    fontFamily: typography.mono,
    fontSize: 12,
    textTransform: "uppercase",
  },
  title: {
    color: colors.ink,
    fontFamily: typography.display,
    fontSize: 36,
    lineHeight: 38,
  },
  body: {
    color: colors.graphite,
    fontFamily: typography.sans,
    fontSize: 15,
    lineHeight: 22,
  },
});
