import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { createContext, PropsWithChildren, useCallback, useContext, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AutofillSafeTextInput as TextInput } from '@/components/AutofillSafeTextInput';
import { thinkingRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { initializeThinkingCoach, respondToThinkingAnswer } from '@/services/thinkingCoach';
import type { Article, ThinkingCoverage, ThinkingEvent, ThinkingReport, ThinkingSession } from '@/types';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { useThemeColors } from '@/utils/theme';
import { getAiLabels } from '@/ai/labels';

type ThinkingContextValue = { openThinkingMode: (article: Article) => void };
const ThinkingContext = createContext<ThinkingContextValue>({ openThinkingMode: () => undefined });
export const useThinkingMode = () => useContext(ThinkingContext);

const operationId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const coverageOf = (session: ThinkingSession): ThinkingCoverage => ({
  summary: Boolean(session.coverage.summary),
  argument: Boolean(session.coverage.argument),
  logic: Boolean(session.coverage.logic),
  importance: Boolean(session.coverage.importance),
  critique: Boolean(session.coverage.critique),
  connection: Boolean(session.coverage.connection),
});

const lastEvent = (session?: ThinkingSession) => session?.events?.[session.events.length - 1];

export function ThinkingModeProvider({ children }: PropsWithChildren) {
  const colors = useThemeColors();
  const desktop = useDesktopLayout();
  const queryClient = useQueryClient();
  const [article, setArticle] = useState<Article | null>(null);
  const [visible, setVisible] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [tab, setTab] = useState<'current' | 'history'>('current');
  const [historyId, setHistoryId] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const openThinkingMode = useCallback((nextArticle: Article) => {
    setArticle(nextArticle);
    setVisible(true);
    setFullscreen(false);
    setTab('current');
    setHistoryId('');
    setError('');
  }, []);

  const sessions = useQuery<ThinkingSession[]>({
    queryKey: ['thinking-sessions', article?.id],
    queryFn: () => thinkingRepo.list(article!.id),
    enabled: Boolean(article?.id),
  });
  const activeSummary = sessions.data?.find((item: ThinkingSession) => item.status === 'active');
  const current = useQuery<ThinkingSession>({
    queryKey: ['thinking-session', activeSummary?.id],
    queryFn: () => thinkingRepo.get(activeSummary!.id),
    enabled: Boolean(activeSummary?.id),
  });
  const history = useQuery<ThinkingSession>({
    queryKey: ['thinking-session', historyId],
    queryFn: () => thinkingRepo.get(historyId),
    enabled: Boolean(historyId),
  });
  const completed = useMemo<ThinkingSession[]>(() => sessions.data?.filter((item: ThinkingSession) => item.status !== 'active') ?? [], [sessions.data]);
  const active = current.data;
  const stale = Boolean(active && article?.contentHash && active.articleContentHash !== article.contentHash);

  const commitSession = useCallback((session: ThinkingSession) => {
    queryClient.setQueryData(['thinking-session', session.id], session);
    queryClient.invalidateQueries({ queryKey: ['thinking-sessions', session.articleId] });
  }, [queryClient]);

  const initializeSession = useCallback(async (session: ThinkingSession, target: Article) => {
    const initial = await initializeThinkingCoach(target);
    const saved = await thinkingRepo.append(session.id, {
      expectedVersion: session.version,
      operationId: operationId(),
      events: [{ kind: 'question', content: initial.question, metadata: { stage: initial.stage } }],
      stage: initial.stage,
      completedRounds: 0,
      coverage: initial.coverage,
      coachState: initial.coachState,
      report: null,
      status: 'active',
    });
    commitSession(saved);
    return saved;
  }, [commitSession]);

  const start = useCallback(async () => {
    if (!article?.contentHash || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await thinkingRepo.create(article.id, article.contentHash);
      queryClient.setQueryData(['thinking-session', created.session.id], created.session);
      await queryClient.invalidateQueries({ queryKey: ['thinking-sessions', article.id] });
      if (!created.session.events?.length) await initializeSession(created.session, article);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.startsWith('AI_API_KEY_REQUIRED:') ? cause.message : t('thinkingSyncFailed'));
    } finally {
      setBusy(false);
    }
  }, [article, busy, initializeSession, queryClient]);

  const finishSavedAnswer = useCallback(async (session: ThinkingSession, savedAnswer: ThinkingEvent) => {
    if (!article) return;
    const reply = await respondToThinkingAnswer({
      articleTitle: article.title,
      stage: session.stage,
      completedRounds: session.completedRounds,
      coverage: coverageOf(session),
      coachState: session.coachState,
      events: session.events ?? [],
      answer: savedAnswer.content,
    });
    const events: Array<{ kind: 'feedback' | 'hint' | 'explanation' | 'question'; content: string; metadata: Record<string, unknown> }> = [
      { kind: reply.kind, content: reply.content, metadata: { stage: session.stage } },
    ];
    if (reply.nextQuestion) events.push({ kind: 'question', content: reply.nextQuestion, metadata: { stage: reply.nextStage } });
    const saved = await thinkingRepo.append(session.id, {
      expectedVersion: session.version,
      operationId: operationId(),
      events,
      stage: reply.nextStage,
      completedRounds: reply.completedRounds,
      coverage: reply.coverage,
      coachState: reply.coachState,
      report: reply.report ?? null,
      status: reply.complete ? 'completed' : 'active',
    });
    commitSession(saved);
    if (reply.complete) {
      setTab('history');
      setHistoryId(saved.id);
    }
  }, [article, commitSession]);

  const submit = useCallback(async () => {
    if (!active || !answer.trim() || busy || stale) return;
    setBusy(true);
    setError('');
    const submitted = answer.trim();
    setAnswer('');
    try {
      const saved = await thinkingRepo.append(active.id, {
        expectedVersion: active.version,
        operationId: operationId(),
        events: [{ kind: 'answer', content: submitted, metadata: { stage: active.stage } }],
        stage: active.stage,
        completedRounds: active.completedRounds,
        coverage: coverageOf(active),
        coachState: active.coachState,
        report: active.report ?? null,
        status: 'active',
      });
      commitSession(saved);
      await finishSavedAnswer(saved, lastEvent(saved)!);
    } catch {
      setError(t('thinkingSyncFailed'));
    } finally {
      setBusy(false);
    }
  }, [active, answer, busy, commitSession, finishSavedAnswer, stale]);

  const retry = useCallback(async () => {
    if (!article || !active || busy) return;
    setBusy(true);
    setError('');
    try {
      const latest = lastEvent(active);
      if (!latest) await initializeSession(active, article);
      else if (latest.kind === 'answer') await finishSavedAnswer(active, latest);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.startsWith('AI_API_KEY_REQUIRED:') ? cause.message : t('thinkingSyncFailed'));
    } finally {
      setBusy(false);
    }
  }, [active, article, busy, finishSavedAnswer, initializeSession]);

  const abandon = useCallback(() => {
    if (!active) return;
    Alert.alert(t('abandonTraining'), t('abandonTrainingConfirm'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('confirm'), style: 'destructive', onPress: async () => {
        try {
          await thinkingRepo.abandon(active.id, active.version);
          queryClient.removeQueries({ queryKey: ['thinking-session', active.id] });
          await queryClient.invalidateQueries({ queryKey: ['thinking-sessions', active.articleId] });
        } catch { setError(t('thinkingSyncFailed')); }
      } },
    ]);
  }, [active, queryClient]);

  const contextValue = useMemo(() => ({ openThinkingMode }), [openThinkingMode]);
  const displayed = tab === 'history' && historyId ? history.data : active;

  return (
    <ThinkingContext.Provider value={contextValue}>
      <View style={styles.host}>
        {children}
        {visible && article && (
          <KeyboardAvoidingView
            pointerEvents="box-none"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.overlay}
          >
            <View style={[
              styles.panel,
              fullscreen ? styles.panelFullscreen : desktop ? styles.panelDesktop : styles.panelMobile,
              { backgroundColor: colors.background, borderColor: colors.border, shadowColor: colors.text },
            ]}>
              <View style={[styles.header, { borderBottomColor: colors.border }]}>
                <View style={styles.headerTitle}>
                  <Ionicons name="bulb-outline" size={19} color={colors.blue} />
                  <Text style={[styles.title, { color: colors.text }]}>{t('thinkingMode')}</Text>
                </View>
                <Pressable style={styles.iconButton} onPress={() => setFullscreen((value) => !value)} accessibilityLabel={fullscreen ? t('halfscreen') : t('fullscreen')}>
                  <Ionicons name={fullscreen ? 'contract-outline' : 'expand-outline'} size={20} color={colors.text} />
                </Pressable>
                <Pressable style={styles.iconButton} onPress={() => setVisible(false)} accessibilityLabel={t('close')}>
                  <Ionicons name="close" size={22} color={colors.text} />
                </Pressable>
              </View>
              <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
                <TabButton label={t('currentTraining')} active={tab === 'current'} colors={colors} onPress={() => { setTab('current'); setHistoryId(''); }} />
                <TabButton label={t('thinkingHistory')} active={tab === 'history'} colors={colors} onPress={() => setTab('history')} />
              </View>
              {tab === 'history' && !historyId ? (
                <ScrollView contentContainerStyle={styles.content}>
                  {!completed.length && <Text style={[styles.empty, { color: colors.secondary }]}>{t('noThinkingHistory')}</Text>}
                  {completed.map((session: ThinkingSession) => (
                    <Pressable key={session.id} style={[styles.historyCard, { borderColor: colors.border, backgroundColor: colors.page }]} onPress={() => setHistoryId(session.id)}>
                      <Text style={[styles.historyDate, { color: colors.secondary }]}>{new Date(session.completedAt ?? session.updatedAt).toLocaleString()}</Text>
                      <Text numberOfLines={2} style={[styles.historySummary, { color: colors.text }]}>{session.report?.articleCore ?? t('abandonedTraining')}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : displayed?.status === 'completed' && displayed.report ? (
                <ReportView report={displayed.report} colors={colors} onBack={tab === 'history' ? () => setHistoryId('') : undefined} />
              ) : (
                <View style={styles.training}>
                  <ScrollView contentContainerStyle={styles.content}>
                    {stale && <Text style={[styles.notice, { color: colors.secondary, borderColor: colors.border }]}>{t('thinkingArticleChanged')}</Text>}
                    {!displayed && !sessions.isLoading && (
                      <StartCard busy={busy} colors={colors} onPress={start} label={completed.length ? t('newTraining') : t('startThinking')} />
                    )}
                    {displayed?.events?.map((event: ThinkingEvent) => <EventBubble key={event.id} event={event} colors={colors} />)}
                    {busy && <View style={styles.loading}><ActivityIndicator color={colors.blue} /><Text style={[styles.loadingText, { color: colors.secondary }]}>{t('thinkingPreparing')}</Text></View>}
                    {!!error && (
                      <View style={[styles.errorCard, { borderColor: colors.border }]}>
                        <Text style={{ color: colors.secondary }}>{error.startsWith('AI_API_KEY_REQUIRED:') ? getAiLabels().apiKeyRequired(error.split(':').slice(1).join(':')) : error}</Text>
                        <Pressable onPress={error.startsWith('AI_API_KEY_REQUIRED:') ? () => { setVisible(false); router.push('/settings'); } : retry}>
                          <Text style={[styles.link, { color: colors.blue }]}>{error.startsWith('AI_API_KEY_REQUIRED:') ? t('configureAi') : t('thinkingRetry')}</Text>
                        </Pressable>
                      </View>
                    )}
                  </ScrollView>
                  {displayed && displayed.status === 'active' && !stale && lastEvent(displayed)?.kind === 'question' && (
                    <View style={[styles.composer, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
                      <Text style={[styles.round, { color: colors.secondary }]}>{t('thinkingRound', { round: Math.min(5, displayed.completedRounds + 1) })}</Text>
                      <TextInput multiline value={answer} onChangeText={setAnswer} editable={!busy} placeholder={t('thinkingPlaceholder')} placeholderTextColor={colors.secondary} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.page }]} />
                      <Pressable disabled={!answer.trim() || busy} onPress={submit} style={({ pressed }) => [styles.submit, { backgroundColor: colors.blue }, (!answer.trim() || busy) && styles.disabled, pressed && styles.pressed]}>
                        <Text style={styles.submitText}>{t('thinkingSubmit')}</Text>
                      </Pressable>
                    </View>
                  )}
                  {displayed?.status === 'active' && (
                    <Pressable style={styles.abandon} onPress={stale ? start : abandon}>
                      <Text style={{ color: stale ? colors.blue : colors.secondary }}>{stale ? t('newTraining') : t('abandonTraining')}</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </KeyboardAvoidingView>
        )}
      </View>
    </ThinkingContext.Provider>
  );
}

function TabButton({ label, active, colors, onPress }: { label: string; active: boolean; colors: any; onPress: () => void }) {
  return <Pressable style={[styles.tab, active && { borderBottomColor: colors.blue }]} onPress={onPress}><Text style={{ color: active ? colors.text : colors.secondary, fontWeight: '700' }}>{label}</Text></Pressable>;
}

function StartCard({ busy, colors, onPress, label = t('startThinking') }: { busy: boolean; colors: any; onPress: () => void; label?: string }) {
  return <Pressable disabled={busy} onPress={onPress} style={({ pressed }) => [styles.startCard, { borderColor: colors.border, backgroundColor: colors.page }, pressed && styles.pressed]}><Ionicons name="bulb-outline" size={24} color={colors.blue} /><Text style={[styles.startText, { color: colors.text }]}>{label}</Text></Pressable>;
}

function EventBubble({ event, colors }: { event: ThinkingEvent; colors: any }) {
  const user = event.kind === 'answer';
  return <View style={[styles.event, user ? styles.userEvent : styles.aiEvent, { backgroundColor: user ? colors.blue : colors.page, borderColor: colors.border }]}><Text selectable style={{ color: user ? '#fff' : colors.text, lineHeight: 21 }}>{event.content}</Text></View>;
}

function ReportView({ report, colors, onBack }: { report: ThinkingReport; colors: any; onBack?: () => void }) {
  const rows = [[t('reportCore'), report.articleCore], [t('reportStrengths'), report.strengths], [t('reportOmissions'), report.omissions], [t('reportDepth'), report.thinkingDepth], [t('reportExpression'), report.expressionIssues]];
  return <ScrollView contentContainerStyle={styles.content}>{onBack && <Pressable onPress={onBack}><Text style={[styles.link, { color: colors.blue }]}>‹ {t('thinkingHistory')}</Text></Pressable>}<Text style={[styles.reportTitle, { color: colors.text }]}>{t('thinkingReport')}</Text>{rows.map(([label, value]) => <View key={label} style={[styles.reportRow, { borderColor: colors.border }]}><Text style={[styles.reportLabel, { color: colors.secondary }]}>{label}</Text><Text selectable style={[styles.reportValue, { color: colors.text }]}>{value}</Text></View>)}</ScrollView>;
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 100 },
  panel: { position: 'absolute', borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 18, elevation: 18 },
  panelMobile: { left: 0, right: 0, bottom: 0, height: '55%', borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  panelDesktop: { top: 0, right: 0, bottom: 0, width: '50%', minWidth: 420, borderTopLeftRadius: 16, borderBottomLeftRadius: 16 },
  panelFullscreen: { top: 0, right: 0, bottom: 0, left: 0 },
  header: { height: 54, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800' },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  tabs: { height: 44, flexDirection: 'row', paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  training: { flex: 1 },
  content: { padding: 16, gap: 12 },
  empty: { textAlign: 'center', marginTop: 40 },
  historyCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 },
  historyDate: { fontSize: 12, marginBottom: 6 },
  historySummary: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  startCard: { margin: 16, minHeight: 100, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 8 },
  startText: { fontWeight: '800' },
  event: { maxWidth: '90%', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  userEvent: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  aiEvent: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
  loading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12 },
  loadingText: { marginLeft: 8, fontSize: 13 },
  notice: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, lineHeight: 20 },
  errorCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 8 },
  link: { fontWeight: '800' },
  composer: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10, borderTopWidth: StyleSheet.hairlineWidth },
  round: { fontSize: 12, marginBottom: 6 },
  input: { minHeight: 64, maxHeight: 130, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, textAlignVertical: 'top' },
  submit: { alignSelf: 'flex-end', marginTop: 8, borderRadius: 18, paddingHorizontal: 16, height: 36, justifyContent: 'center' },
  submitText: { color: '#fff', fontWeight: '800' },
  abandon: { alignItems: 'center', paddingVertical: 8 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
  reportTitle: { fontSize: 20, fontWeight: '800', marginVertical: 6 },
  reportRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  reportLabel: { fontSize: 12, fontWeight: '700', marginBottom: 5 },
  reportValue: { fontSize: 14, lineHeight: 21 },
});
