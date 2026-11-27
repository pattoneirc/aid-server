import { useEffect, useState } from 'react';
import { ReloadOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input, InputNumber,
  Select, Space, Spin, Switch, Table, Tag, Typography, message, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  getModelLog, getModelLogSettings, listModelLogs, saveModelLogSettings,
  type ModelLogQuery, type ModelLogRecord, type ModelLogSettings, type ModelLogStatus,
} from '@/api/aid/modelRequestLog';
import { useAuth } from '@/hooks/useAuth';

const types = [
  { value: 'text', label: '文本' }, { value: 'image', label: '图片' },
  { value: 'video', label: '视频' }, { value: 'audio', label: '语音' },
  { value: 'music', label: '音乐' }, { value: 'asr', label: '语音识别' },
];
const operations: Record<string, string> = {
  submit: '提交', query: '查询上游任务', chatSync: '同步对话', streamChat: '流式对话',
};
const statuses: Record<string, { text: string; color?: string }> = {
  RESPONDED: { text: '已响应', color: 'processing' },
  FAILED: { text: '请求失败', color: 'error' },
  UNKNOWN: { text: '未采集状态' },
};

function prettyBody(text?: string) {
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

export default function ModelRequestLogPage() {
  const { token } = theme.useToken();
  const { hasPermi } = useAuth();
  const [filters] = Form.useForm<ModelLogQuery>();
  const [settingsForm] = Form.useForm<ModelLogSettings>();
  const customStorage = Form.useWatch('customStorage', settingsForm);
  const [query, setQuery] = useState<ModelLogQuery>({});
  const [refresh, setRefresh] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [rows, setRows] = useState<ModelLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<ModelLogRecord>();
  const [detail, setDetail] = useState<string>();
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState<ModelLogStatus>();
  const [settingsError, setSettingsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const before = cursors[cursors.length - 1];

  useEffect(() => {
    let current = true;
    setLoading(true);
    setListError(false);
    listModelLogs({ ...query, before, size: 30 }).then(({ data }) => {
      if (!current) return;
      setRows(data.records);
      setNextCursor(data.nextCursor || undefined);
    }).catch(() => {
      if (!current) return;
      setRows([]);
      setNextCursor(undefined);
      setListError(true);
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, before, refresh]);

  useEffect(() => {
    if (!selected) return;
    let current = true;
    setDetail(undefined);
    setDetailState('loading');
    getModelLog(selected.id).then(({ data }) => {
      if (!current) return;
      setDetail(prettyBody(data));
      setDetailState('ready');
    }).catch(() => { if (current) setDetailState('error'); });
    return () => { current = false; };
  }, [selected]);

  useEffect(() => {
    if (!settingsOpen) return;
    let current = true;
    setSettingsStatus(undefined);
    setSettingsError(false);
    getModelLogSettings().then(({ data }) => {
      if (!current) return;
      setSettingsStatus(data);
      settingsForm.setFieldsValue(data.settings);
    }).catch(() => { if (current) setSettingsError(true); });
    return () => { current = false; };
  }, [settingsOpen, settingsForm]);

  async function saveSettings(values: ModelLogSettings) {
    setSaving(true);
    try {
      const { data } = await saveModelLogSettings(values);
      setSettingsStatus(data);
      settingsForm.setFieldsValue(data.settings);
      message.success('日志设置已保存');
    } catch {
      // The common request handler shows the server's validation message.
    } finally { setSaving(false); }
  }

  const columns: ColumnsType<ModelLogRecord> = [
    { title: '请求时间', dataIndex: 'startedAt', width: 178,
      render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—' },
    { title: '模型', dataIndex: 'modelCode', width: 180, ellipsis: true },
    { title: '供应商', dataIndex: 'providerCode', width: 135, ellipsis: true },
    { title: '类型', dataIndex: 'modelType', width: 96,
      render: (value: string) => <Tag>{types.find(item => item.value === value)?.label ?? value}</Tag> },
    { title: '操作', dataIndex: 'operation', width: 115, render: (value: string) => operations[value] ?? value },
    { title: '关联业务', key: 'business', width: 175, render: (_, row) => row.businessId
      ? <Space size={4}>{row.businessType && <Tag>{row.businessType}</Tag>}<Typography.Text copyable>{row.businessId}</Typography.Text></Space>
      : row.taskId ? <Typography.Text copyable>{row.taskId}</Typography.Text> : '—' },
    { title: '耗时', dataIndex: 'elapsedMs', width: 85, render: (value: number) => `${value} ms` },
    { title: '状态', dataIndex: 'status', width: 112,
      render: (value: string) => <Tag color={statuses[value]?.color}>{statuses[value]?.text ?? value}</Tag> },
  ];
  if (hasPermi('system:model-request-log:detail')) {
    columns.push({ title: '详情', width: 95, key: 'detail',
      render: (_, row) => <Button type="link" onClick={() => setSelected(row)}>查看</Button> });
  }

  function search(values: ModelLogQuery) {
    setCursors([]);
    setQuery({ type: values.type, model: values.model?.trim(), provider: values.provider?.trim() });
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="模型请求日志" extra={hasPermi('system:model-request-log:manage') &&
        <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>日志设置</Button>}>
        <Form form={filters} layout="inline" onFinish={search} style={{ marginBottom: 16, rowGap: 8 }}>
          <Form.Item name="type" label="模型类型">
            <Select options={types} placeholder="全部类型" allowClear style={{ width: 128 }} />
          </Form.Item>
          <Form.Item name="model" label="模型"><Input allowClear placeholder="模型代码" maxLength={191} /></Form.Item>
          <Form.Item name="provider" label="供应商"><Input allowClear placeholder="供应商代码" maxLength={100} /></Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button>
            <Button icon={<ReloadOutlined />} onClick={() => setRefresh(value => value + 1)}>刷新</Button>
          </Space>
        </Form>
        {listError && <Alert type="error" showIcon message="日志列表加载失败，请刷新重试。" style={{ marginBottom: 12 }} />}
        <Table rowKey="id" size="middle" loading={loading} columns={columns} dataSource={rows}
          scroll={{ x: 1090 }} pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无匹配的模型请求日志" /> }} />
        <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Typography.Text type="secondary">第 {cursors.length + 1} 页</Typography.Text>
          <Button disabled={loading || cursors.length === 0} onClick={() => setCursors(current => current.slice(0, -1))}>上一页</Button>
          <Button disabled={loading || !nextCursor} onClick={() => nextCursor && setCursors(current => [...current, nextCursor])}>下一页</Button>
        </Space>
      </Card>

      <Drawer open={!!selected} title={selected ? `请求详情 · ${selected.id}` : '请求详情'}
        width={720} onClose={() => setSelected(undefined)}>
        {selected && <Descriptions size="small" column={2} style={{ marginBottom: 16 }} items={[
          { key: 'model', label: '模型', children: selected.modelCode },
          { key: 'provider', label: '供应商', children: selected.providerCode ?? '—' },
          { key: 'task', label: '媒体任务 ID', children: selected.taskId ? <Typography.Text copyable>{selected.taskId}</Typography.Text> : '—' },
          { key: 'business', label: '业务 ID', children: selected.businessId ? <Typography.Text copyable>{selected.businessId}</Typography.Text> : '—' },
        ]} />}
        {detailState === 'loading' && <Spin />}
        {detailState === 'error' && <Alert type="warning" showIcon message="日志正文已清理或暂时无法读取。" />}
        {detailState === 'ready' && detail && <pre style={{
          background: token.colorFillQuaternary, padding: 16, borderRadius: token.borderRadius,
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0,
        }}>{detail}</pre>}
      </Drawer>

      <Drawer open={settingsOpen} title="日志设置" width={520} onClose={() => { if (!saving) setSettingsOpen(false); }}
        extra={<Button type="primary" disabled={!settingsStatus} loading={saving} onClick={settingsForm.submit}>保存设置</Button>}>
        {settingsError && <Alert type="error" showIcon message="设置加载失败，关闭后可重试。" />}
        {!settingsError && !settingsStatus && <Spin />}
        {settingsStatus && (
          <Form form={settingsForm} layout="vertical" onFinish={saveSettings} disabled={saving}>
            <Form.Item label="记录模型类型" name="enabledTypes" help="只记录已勾选类型的新请求。">
              <Checkbox.Group options={types} />
            </Form.Item>
            <Form.Item label="保留天数" name="retentionDays" extra="超期日志会在后台自动清理。"
              rules={[{ required: true, message: '请填写保留天数' }]}>
              <InputNumber min={1} max={90} precision={0} addonAfter="天" />
            </Form.Item>
            <Form.Item label="容量上限" name="maxMiB" extra="超过上限时，从最早保存的记录开始清理。"
              rules={[{ required: true, message: '请填写容量上限' }]}>
              <InputNumber min={32} max={16384} precision={0} addonAfter="MiB" />
            </Form.Item>
            <Form.Item label="独立存储目录" name="customStorage" valuePropName="checked">
              <Switch checkedChildren="独立" unCheckedChildren="默认" />
            </Form.Item>
            {customStorage && <Form.Item label="服务器目录" name="storageDirectory"
              rules={[{ required: true, whitespace: true, message: '请填写服务器上的绝对目录' }]}>
              <Input maxLength={512} placeholder="/var/lib/aid/private" />
            </Form.Item>}
            <Descriptions size="small" column={1} items={[
              { key: 'directory', label: '当前写入目录', children: <Typography.Text style={{ overflowWrap: 'anywhere' }}>{settingsStatus.effectiveDirectory}</Typography.Text> },
              { key: 'dropped', label: '本次运行排队丢弃', children: settingsStatus.dropped },
              { key: 'failed', label: '本次运行写入失败', children: settingsStatus.failed },
            ]} />
          </Form>
        )}
      </Drawer>
    </Space>
  );
}
