import React from 'react';
import { Collapse, Image, Modal, Spin, Tag } from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import type { ConfigTestResult } from '@/api/system/configTest';

interface Props {
  open: boolean;
  /** 测试结果；为 null 时不渲染内容 */
  result: ConfigTestResult | null;
  onClose: () => void;
}

/**
 * 配置连通性测试结果弹窗。
 * 成功/失败图标 + message + 折叠区(details + elapsedMs + provider)。
 * details 为空则不显示折叠区。
 */
export default function TestResultModal({ open, result, onClose }: Props) {
  const success = !!result?.success;
  const running = result?.mediaStatus === 'running';
  const isGeneration = Boolean(result?.mediaStatus || result?.mediaType || result?.outputText);
  const hasDetails = !!(result?.details && String(result.details).trim());

  return (
    <Modal
      open={open}
      title={isGeneration ? '模型生成测试' : '连通性测试结果'}
      onCancel={onClose}
      onOk={onClose}
      footer={null}
      destroyOnClose
      width={560}
    >
      {result && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
            {running ? <Spin /> : success ? (
              <CheckCircleFilled style={{ fontSize: 32, color: '#52c41a' }} />
            ) : (
              <CloseCircleFilled style={{ fontSize: 32, color: '#ff4d4f' }} />
            )}
            <div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                {running ? '正在生成' : isGeneration ? (success ? '生成成功' : '生成失败') : success ? '连接成功' : '连接失败'}
              </div>
              <div style={{ color: '#64748b', marginTop: 2 }}>{result.message}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            {result.provider && (
              <span style={{ color: '#64748b', fontSize: 12 }}>
                命中厂商：<Tag bordered={false}>{result.provider}</Tag>
              </span>
            )}
            {!result.mediaType && <span style={{ color: '#64748b', fontSize: 12 }}>
              耗时：<Tag bordered={false} color="blue">{result.elapsedMs} ms</Tag>
            </span>}
            {result.testSpec && <Tag bordered={false}>{result.testSpec}</Tag>}
          </div>

          {result.mediaUrl && (result.mediaType === 'video' ? (
            <video controls playsInline preload="metadata" src={result.mediaUrl} style={{ width: '100%', maxHeight: 340, borderRadius: 8 }} />
          ) : (
            <Image src={result.mediaUrl} alt="模型测试生成的图片" style={{ width: '100%', maxHeight: 340, objectFit: 'contain', borderRadius: 8 }} />
          ))}

          {result.outputText && (
            <pre aria-label="模型回复" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>
              {result.outputText}
            </pre>
          )}

          {hasDetails && (
            <Collapse
              ghost
              items={[
                {
                  key: 'details',
                  label: <span style={{ fontWeight: 500 }}>详细信息</span>,
                  children: (
                    <pre
                      style={{
                        background: '#0f172a',
                        color: '#94e3b1',
                        padding: 12,
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: 1.5,
                        margin: 0,
                        maxHeight: 320,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontFamily: 'Consolas, Menlo, monospace'
                      }}
                    >
                      {result.details}
                    </pre>
                  )
                }
              ]}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
