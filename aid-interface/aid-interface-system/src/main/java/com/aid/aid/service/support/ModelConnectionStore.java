package com.aid.aid.service.support;

import com.aid.common.exception.ServiceException;
import com.aid.common.utils.GatewayUrlUtils;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Model connection revisions allow in-flight tasks to use their original address and key. */
@Component
public class ModelConnectionStore {
    private static final int NONCE_LENGTH = 12;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final JdbcTemplate jdbc;
    private final SecretKeySpec key;

    public ModelConnectionStore(JdbcTemplate jdbc,
            @Value("${aid.model-connection.secret-key:${token.secret:}}") String secret) {
        this.jdbc = jdbc;
        try {
            this.key = secret == null || secret.isBlank() ? null : new SecretKeySpec(
                    MessageDigest.getInstance("SHA-256")
                            .digest(("aid.model-connection:" + secret).getBytes(StandardCharsets.UTF_8)), "AES");
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("模型连接凭据初始化失败", exception);
        }
    }

    public record Connection(String baseUrl, String apiKey) {
        @Override
        public String toString() {
            return "ModelConnection[credentials protected]";
        }
    }

    public Connection load(long modelId, long revision) {
        var rows = jdbc.query(
                "SELECT base_url, encrypted_key FROM aid_ai_model_connection WHERE model_id=? AND revision=?",
                (row, index) -> new Connection(row.getString("base_url"),
                        decrypt(modelId, revision, row.getString("encrypted_key"))), modelId, revision);
        if (rows.isEmpty()) throw new ServiceException("模型专属连接版本不存在");
        return rows.get(0);
    }

    public String baseUrl(long modelId, long revision) {
        return jdbc.queryForObject(
                "SELECT base_url FROM aid_ai_model_connection WHERE model_id=? AND revision=?",
                String.class, modelId, revision);
    }

    public void save(long modelId, long revision, Connection connection) {
        jdbc.update("INSERT INTO aid_ai_model_connection (model_id,revision,base_url,encrypted_key) VALUES (?,?,?,?)",
                modelId, revision, connection.baseUrl(), encrypt(modelId, revision, connection.apiKey()));
    }

    public Connection validate(String baseUrl, String apiKey) {
        if (baseUrl == null || baseUrl.length() > 1024 || !GatewayUrlUtils.isBaseGatewayUrl(baseUrl)) {
            throw new ServiceException("请填写合法的模型专属 Base URL");
        }
        if (apiKey == null || apiKey.isBlank() || apiKey.length() > 2048 || apiKey.chars().anyMatch(Character::isISOControl)) {
            throw new ServiceException("请填写合法的模型专属 API Key");
        }
        return new Connection(GatewayUrlUtils.normalizeBaseGatewayUrl(baseUrl), apiKey.trim());
    }

    private String encrypt(long modelId, long revision, String value) {
        try {
            byte[] nonce = new byte[NONCE_LENGTH];
            RANDOM.nextBytes(nonce);
            byte[] encrypted = cipher(Cipher.ENCRYPT_MODE, nonce, modelId, revision)
                    .doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] payload = Arrays.copyOf(nonce, nonce.length + encrypted.length);
            System.arraycopy(encrypted, 0, payload, nonce.length, encrypted.length);
            return Base64.getEncoder().encodeToString(payload);
        } catch (GeneralSecurityException exception) {
            throw new ServiceException("无法加密模型专属 API Key");
        }
    }

    private String decrypt(long modelId, long revision, String secret) {
        try {
            byte[] payload = Base64.getDecoder().decode(secret);
            byte[] plaintext = cipher(Cipher.DECRYPT_MODE, Arrays.copyOf(payload, NONCE_LENGTH), modelId, revision)
                    .doFinal(payload, NONCE_LENGTH, payload.length - NONCE_LENGTH);
            return new String(plaintext, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException exception) {
            throw new ServiceException("无法解密模型专属 API Key");
        }
    }

    private Cipher cipher(int mode, byte[] nonce, long modelId, long revision) throws GeneralSecurityException {
        if (key == null) throw new ServiceException("部署配置缺少模型连接加密密钥");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, key, new GCMParameterSpec(128, nonce));
        cipher.updateAAD((modelId + "/" + revision).getBytes(StandardCharsets.UTF_8));
        return cipher;
    }
}
