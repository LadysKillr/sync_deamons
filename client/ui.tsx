import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

/** Petites briques d'interface, couleurs tirées du thème (clair et sombre). */

export function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    return {
      c,
      screen: { padding: compact ? 14 : 24, gap: 16, backgroundColor: c.surface0 },
      card: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: compact ? 12 : 16, gap: 10, backgroundColor: c.surface1 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 8 },
      h1: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" as const },
      h2: { color: c.foreground, fontSize: 16, fontWeight: "600" as const },
      text: { color: c.foreground, fontSize: 14 },
      muted: { color: c.foregroundMuted, fontSize: 13 },
      danger: { color: c.statusDanger, fontSize: 13 },
      success: { color: c.statusSuccess, fontSize: 13 },
      warning: { color: c.statusWarning, fontSize: 13 },
      input: {
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: c.foreground,
        backgroundColor: c.surface0,
        fontSize: 14,
        minWidth: compact ? 0 : 220,
      },
      mono: { fontFamily: "monospace", color: c.foreground, fontSize: 12 },
    };
  }, [theme, compact]);
}

export type Styles = ReturnType<typeof useStyles>;

export function Button(props: { s: Styles; label: string; onPress(): void; kind?: "primary" | "plain" | "danger"; disabled?: boolean }) {
  const { s, kind = "plain" } = props;
  const background = kind === "primary" ? s.c.accent : kind === "danger" ? s.c.statusDanger : s.c.surface2;
  const color = kind === "primary" ? s.c.accentForeground : kind === "danger" ? s.c.surface0 : s.c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: background, opacity: props.disabled ? 0.5 : 1 }}
    >
      <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{props.label}</Text>
    </Pressable>
  );
}

export function Toggle(props: { s: Styles; label: string; value: boolean; onChange(value: boolean): void }) {
  const { s } = props;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.value }}
      accessibilityLabel={props.label}
      onPress={() => props.onChange(!props.value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: props.value ? s.c.accent : s.c.border,
          backgroundColor: props.value ? s.c.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {props.value ? <Text style={{ color: s.c.accentForeground, fontSize: 12, lineHeight: 14 }}>✓</Text> : null}
      </View>
      <Text style={s.text}>{props.label}</Text>
    </Pressable>
  );
}

export function Chip(props: { s: Styles; label: string; active: boolean; onPress(): void; disabled?: boolean }) {
  const { s } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: props.active ? s.c.accent : s.c.border,
        backgroundColor: props.active ? s.c.accent : "transparent",
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color: props.active ? s.c.accentForeground : s.c.foreground, fontSize: 12 }}>{props.label}</Text>
    </Pressable>
  );
}

export function Field(props: {
  s: Styles;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
  hint?: string;
}) {
  const { s } = props;
  return (
    <View style={{ gap: 4, flexGrow: 1 }}>
      <Text style={s.muted}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={s.c.foregroundMuted}
        secureTextEntry={props.secure}
        multiline={props.multiline}
        autoCapitalize="none"
        autoCorrect={false}
        style={[s.input, props.multiline ? { minHeight: 70, textAlignVertical: "top" as const } : null]}
      />
      {props.hint ? <Text style={s.muted}>{props.hint}</Text> : null}
    </View>
  );
}

export function Section(props: { s: Styles; title: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <View style={props.s.card}>
      <View style={[props.s.row, { justifyContent: "space-between" }]}>
        <Text style={props.s.h2}>{props.title}</Text>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

export function ago(at: number | null, now = Date.now()): string {
  if (!at) return "jamais";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.round(seconds / 3600)} h`;
  return `il y a ${Math.round(seconds / 86400)} j`;
}
