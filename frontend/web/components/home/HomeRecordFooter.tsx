'use client'

import { useAuthPublicConfig } from '@/hooks/useAuthPublicConfig'
import styles from './HomeRecordFooter.module.css'

export function HomeRecordFooter() {
  const { recordFilingNumber } = useAuthPublicConfig()
  if (!recordFilingNumber) return null

  return (
    <footer className={styles.footer}>
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
        {recordFilingNumber}
      </a>
    </footer>
  )
}
