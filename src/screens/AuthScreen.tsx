import { Ionicons } from '@expo/vector-icons';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView,
  ScrollView, StyleSheet, Text, TextInput, type TextInputProps, View,
} from 'react-native';
import { useAuthStore } from '@/auth/authStore';
import { ApiError } from '@/api/client';
import { useThemeColors } from '@/utils/theme';

type Mode = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
type IconName = ComponentProps<typeof Ionicons>['name'];

const modeCopy = {
  login: ['欢迎回来', '登录后继续你的专注阅读。', '登录'],
  register: ['创建账号', '建立属于你的智能阅读空间。', '创建账号'],
  verify: ['验证邮箱', '输入邮件中的验证码以完成验证。', '完成验证'],
  forgot: ['找回密码', '输入注册邮箱，我们会发送重置验证码。', '发送验证码'],
  reset: ['设置新密码', '输入验证码并设置新的安全密码。', '重置密码'],
} satisfies Record<Mode, [string, string, string]>;

function Field({ icon, label, right, ...props }: TextInputProps & {
  icon: IconName; label: string; right?: ReactNode;
}) {
  const theme = useThemeColors();
  const [focused, setFocused] = useState(false);
  return <View style={styles.fieldGroup}>
    <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
    <View style={[styles.field, {
      backgroundColor: theme.background,
      borderColor: focused ? theme.blue : theme.border,
    }, focused && styles.fieldFocused]}>
      <Ionicons name={icon} size={18} color={focused ? theme.blue : theme.subtle} />
      <TextInput {...props} accessibilityLabel={label} placeholderTextColor={theme.subtle}
        selectionColor={theme.blue} style={[styles.input, { color: theme.text }]}
        onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e); }} />
      {right}
    </View>
  </View>;
}

function Logo({ color = '#3B82F6' }: { color?: string }) {
  return <View style={[styles.logo, { backgroundColor: color }]}>
    <Ionicons name="sparkles" size={19} color="#fff" />
  </View>;
}

function Notice({ error, children }: { error?: boolean; children: string }) {
  const color = error ? '#C2413D' : '#16834B';
  return <View style={[styles.notice, error ? styles.errorNotice : styles.successNotice]}>
    <Ionicons name={error ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={18} color={color} />
    <Text style={[styles.noticeText, { color }]}>{children}</Text>
  </View>;
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const auth = useAuthStore();
  const theme = useThemeColors();
  const [title, subtitle, action] = modeCopy[mode];
  const go = (next: Mode) => {
    setMode(next); setMessage(''); setError(''); setShowPassword(false);
  };
  const submit = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'login') await auth.login(email, password);
      if (mode === 'register') { await auth.register(email, password); setMode('verify'); setMessage('验证邮件已发送，请输入邮件中的验证码。'); }
      if (mode === 'verify') { await auth.verifyEmail(token.trim()); await auth.login(email, password); }
      if (mode === 'forgot') { await auth.forgotPassword(email); setMode('reset'); setMessage('如果该邮箱已注册，重置验证码会发送到邮箱。'); }
      if (mode === 'reset') { await auth.resetPassword(token.trim(), password); setMode('login'); setToken(''); setMessage('密码已重置，请登录。'); }
    } catch (e) {
      const errorCode = e instanceof ApiError
        ? e.code
        : (typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '');
      const errorStatus = e instanceof ApiError
        ? e.status
        : (typeof e === 'object' && e !== null && 'status' in e ? Number(e.status) : 0);
      if (mode === 'login' && (errorCode === 'email_not_verified' || errorStatus === 403)) {
        setMode('verify');
        setMessage('邮箱尚未验证，正在重新发送验证码。');
        try {
          await auth.resendVerification(email);
          setMessage('邮箱尚未验证，新的验证码已发送。');
        } catch {
          setMessage('邮箱尚未验证，请输入已有验证码或点击重新发送。');
        }
      } else setError(e instanceof Error ? e.message : '请求失败');
    }
    finally { setBusy(false); }
  };
  const eye = <Pressable accessibilityRole="button" accessibilityLabel={showPassword ? '隐藏密码' : '显示密码'}
    hitSlop={8} onPress={() => setShowPassword((v) => !v)} style={({ pressed }) => [styles.eye, pressed && styles.pressed]}>
    <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={19} color={theme.secondary} />
  </Pressable>;
  const emailField = mode !== 'verify' && mode !== 'reset' ? <Field icon="mail-outline" label="邮箱"
    autoCapitalize="none" autoComplete="email" keyboardType="email-address"
    placeholder="name@example.com" value={email} onChangeText={setEmail}
    returnKeyType={mode === 'forgot' ? 'send' : 'next'}
    onSubmitEditing={mode === 'forgot' ? submit : undefined} /> : null;
  const tokenField = mode === 'verify' || mode === 'reset' ? <Field icon="key-outline" label="邮件验证码"
    autoCapitalize="none" autoComplete="one-time-code" keyboardType="number-pad"
    placeholder="输入邮件中的验证码" value={token} onChangeText={setToken} /> : null;
  const passwordField = mode === 'login' || mode === 'register' || mode === 'reset'
    ? <Field icon="lock-closed-outline" label={mode === 'reset' ? '新密码' : '密码'}
        secureTextEntry={showPassword === false}
        placeholder="至少 10 个字符"
        value={password} onChangeText={setPassword} right={eye} />
    : null;
  const modeLinks = mode === 'login' ? <View style={styles.links}>
    <Pressable onPress={() => go('forgot')}><Text style={[styles.mutedLink, { color: theme.secondary }]}>忘记密码？</Text></Pressable>
    <View style={[styles.divider, { backgroundColor: theme.border }]} />
    <Pressable onPress={() => go('register')}><Text style={[styles.link, { color: theme.blue }]}>没有账号？立即注册</Text></Pressable>
  </View> : <Pressable style={styles.centerLink} onPress={() => go('login')}>
    <Ionicons name="arrow-back" size={16} color={theme.blue} />
    <Text style={[styles.link, { color: theme.blue }]}>返回登录</Text>
  </Pressable>;
  return <SafeAreaView style={[styles.safe, { backgroundColor: theme.page }]}>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={[styles.shell, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.form}>
            <View style={styles.mobileBrand}>
              <Logo color={theme.blue} /><Text style={[styles.brand, { color: theme.text }]}>FeedMind</Text>
            </View>
            <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
            <Text style={[styles.subtitle, { color: theme.secondary }]}>{subtitle}</Text>
            <View style={styles.fields}>{emailField}{tokenField}{passwordField}</View>
            {message ? <Notice>{message}</Notice> : null}
            {error ? <Notice error>{error}</Notice> : null}
            <Pressable accessibilityRole="button" accessibilityLabel={action} onPress={submit} disabled={busy}
              style={({ pressed }) => [styles.button, { backgroundColor: theme.blue },
                pressed && busy === false && styles.buttonPressed, busy && styles.buttonBusy]}>
              {busy ? <ActivityIndicator color="#fff" /> : <>
                <Text style={styles.buttonText}>{action}</Text><Ionicons name="arrow-forward" size={18} color="#fff" />
              </>}
            </Pressable>
            {mode === 'verify' ? <Pressable style={styles.centerLink} onPress={async () => {
              await auth.resendVerification(email); setMessage('验证邮件已重新发送。');
            }}><Text style={[styles.link, { color: theme.blue }]}>重新发送验证邮件</Text></Pressable> : null}
            {modeLinks}
            <Text style={[styles.legal, { color: theme.subtle }]}>安全登录 · 数据同步由 FeedMind 提供</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  shell: {
    width: '100%', maxWidth: 420, alignSelf: 'center', borderWidth: 1,
    borderRadius: 16, overflow: 'hidden',
    ...Platform.select({ web: { boxShadow: '0 10px 30px rgba(15,23,42,0.06)' }, default: {} }),
  },
  logo: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  form: { paddingHorizontal: 36, paddingVertical: 40 },
  mobileBrand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 34 },
  brand: { fontSize: 22, fontWeight: '800' },
  title: { fontSize: 29, lineHeight: 36, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { fontSize: 14, lineHeight: 22, marginTop: 8, marginBottom: 30 },
  fields: { gap: 18 },
  fieldGroup: { gap: 8 },
  label: { fontSize: 13, fontWeight: '700' },
  field: { height: 52, borderWidth: 1, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 15 },
  fieldFocused: Platform.select({ web: { boxShadow: '0 0 0 3px rgba(10,132,255,0.12)' }, default: {} }),
  input: { flex: 1, height: '100%', fontSize: 15, outlineStyle: 'none' } as never,
  eye: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 11, borderWidth: 1, padding: 12, marginTop: 16 },
  successNotice: { backgroundColor: '#F0FBF5', borderColor: '#CDEEDC' },
  errorNotice: { backgroundColor: '#FFF5F4', borderColor: '#F3D4D1' },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 19 },
  button: {
    height: 52, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 9, marginTop: 22,
    ...Platform.select({ web: { boxShadow: '0 8px 20px rgba(10,132,255,0.22)', cursor: 'pointer' }, default: {} }),
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  buttonPressed: { opacity: 0.88, transform: [{ translateY: 1 }] },
  buttonBusy: { opacity: 0.72 },
  links: { minHeight: 44, marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap' },
  divider: { width: 1, height: 14 },
  centerLink: { minHeight: 44, marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  link: { fontSize: 13, fontWeight: '700' },
  mutedLink: { fontSize: 13, fontWeight: '600' },
  legal: { fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 24 },
  pressed: { opacity: 0.58 },
});
