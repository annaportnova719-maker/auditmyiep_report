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
    en: 'Private by design. Your IEP is analyzed by secure AI and is never stored, never used to train AI, and deleted the moment your report is ready. Only you see it.',
    es: 'Privado por diseño. Su IEP se analiza con IA segura y nunca se almacena, nunca se usa para entrenar IA y se elimina en cuanto su informe está listo. Solo usted lo ve.',
  },
  'audit.consent': {
    en: 'Email me my report and occasional updates (unsubscribe anytime). I agree to the Terms of Service and Privacy Policy.',
    es: 'Envíenme mi informe y actualizaciones ocasionales (puedo cancelar en cualquier momento). Acepto los Términos de Servicio y la Política de Privacidad.',
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
