import React, { createContext, useContext, useState, useCallback } from 'react'

// The same translation table from your Base44 build (trimmed to what this
// simpler app actually renders). English/Spanish both still work — just
// pass ?lang=es or wire up a toggle later.
const translations = {
  'hero.title': { en: "Know what your child's IEP actually promises.", es: 'Sepa lo que el IEP de su hijo/a realmente promete.' },
  'audit.upload': { en: 'Upload IEP PDF', es: 'Subir IEP en PDF' },
  'audit.run': { en: 'Run audit', es: 'Ejecutar auditoría' },
  'audit.running': { en: 'Auditing your IEP… full reports can take several minutes because of how thorough this audit is. Please stay on this page.', es: 'Auditando su IEP… los informes completos pueden tardar varios minutos porque la auditoría es muy detallada. Por favor, no cierre esta página.' },
  'audit.print': { en: 'Download / print PDF', es: 'Descargar / imprimir PDF' },
  'audit.privacy': {
    en: 'Private by design. Your IEP is never stored, logged, or kept — it’s read only to build this report, then it’s gone.',
    es: 'Privado por diseño. Su IEP nunca se almacena, registra ni conserva: solo se lee para crear este informe y luego desaparece.',
  },
  'audit.consent': {
    en: 'I’m the parent or legal guardian of this child (or authorized to share their records). I understand IEPs can hold sensitive medical, psychological, behavioral, and disciplinary details, and I consent to my document being read by a secure third-party AI to generate this report. AuditMyIEP is an educational tool, not legal advice.',
    es: 'Soy el padre, madre o tutor/a legal de este niño/a (o estoy autorizado/a para compartir sus documentos). Entiendo que los IEP pueden contener información médica, psicológica, conductual y disciplinaria sensible, y doy mi consentimiento para que mi documento sea leído por una IA externa segura para generar este informe. AuditMyIEP es una herramienta educativa, no asesoría legal.',
  },
  'audit.sub.compliance': { en: 'Compliance', es: 'Cumplimiento' },
  'audit.sub.enforce': { en: 'Enforceable', es: 'Exigible' },
  'report.outOf': { en: 'out of 100', es: 'de 100' },
  'report.headline': { en: 'The headline', es: 'El resumen' },
  'report.strengths': { en: 'Genuinely strong', es: 'Genuinamente fuerte' },
  'report.weakPoints': { en: 'Weak Points that Matter Most', es: 'Puntos débiles que más importan' },
  'report.sections': { en: 'Section-by-section audit', es: 'Auditoría sección por sección' },
  'report.sectionLead': { en: 'Each section is graded on whether it’s specific enough to hold the school to. Page numbers come from your uploaded IEP.', es: 'Cada sección se califica según si es lo suficientemente específica para exigirle a la escuela.' },
  'report.whatFound': { en: 'What we found', es: 'Lo que encontramos' },
  'report.yourMove': { en: 'Your move', es: 'Su jugada' },
  'report.drawer': { en: 'Understand it & how to advocate', es: 'Entiéndalo y cómo abogar' },
  'report.plainTerms': { en: 'In plain terms', es: 'En términos sencillos' },
  'report.fallsShort': { en: 'Why this IEP falls short', es: 'Por qué este IEP falla' },
  'report.askRoom': { en: 'Ask in the room', es: 'Pregunte en la reunión' },
  'report.askStart': { en: 'Start', es: 'Empezar' },
  'report.askVague': { en: 'If vague', es: 'Si es vago' },
  'report.askStuck': { en: 'If stuck', es: 'Si se estanca' },
  'report.askFor': { en: 'What to ask for', es: 'Qué pedir' },
  'report.shouldSay': { en: 'What it should say in the IEP', es: 'Lo que debería decir el IEP' },
  'report.ifNoDetail': { en: 'If you don’t have this detail yet', es: 'Si aún no tiene este detalle' },
  'report.roomTitle': { en: 'How to use this in the room', es: 'Cómo usar esto en la reunión' },
  'common.loading': { en: 'Loading…', es: 'Cargando…' },

  'report.sayThis': { en: 'What to say at the meeting', es: 'Qué decir en la reunión' },
  'report.getInWriting': { en: 'Get it in writing', es: 'Póngalo por escrito' },
  'report.changeToAsk': { en: 'The change to ask for', es: 'El cambio a solicitar' },
  'report.whyTarget': { en: 'Why this target', es: 'Por qué este objetivo' },
  'report.tracking': { en: 'How progress will be tracked', es: 'Cómo se hará seguimiento del progreso' },
  'report.services': { en: 'Services that support this', es: 'Servicios que respaldan esto' },
  'report.modelLanguage': { en: 'Ready-to-send language for the IEP', es: 'Texto listo para enviar para el IEP' },
  'report.copy': { en: 'Copy', es: 'Copiar' },
  'report.copied': { en: 'Copied', es: 'Copiado' },
  'report.copyAll': { en: 'Copy all', es: 'Copiar todo' },
}

const LanguageContext = createContext({ lang: 'en', setLang: () => {}, t: (k) => k })

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState('en')

  const setLang = useCallback((l) => {
    setLangState(l)
    document.documentElement.lang = l
  }, [])

  const t = useCallback((key) => {
    const entry = translations[key]
    if (!entry) return key
    return entry[lang] || entry.en || key
  }, [lang])

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useI18n() {
  return useContext(LanguageContext)
}
