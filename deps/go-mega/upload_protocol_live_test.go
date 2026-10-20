package mega

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestLiveUploadProtocol(t *testing.T) {
	if os.Getenv("RFORK_LIVE_PROTOCOL") != "1" || flag.Lookup("test.run").Value.String() != "^TestLiveUploadProtocol$" {
		t.Skip("manual dedicated-account protocol probe only")
	}
	email, password := os.Getenv("RFORK_MEGA_EMAIL"), os.Getenv("RFORK_MEGA_PASSWORD")
	stock, reportPath, folder := os.Getenv("RFORK_PROTOCOL_STOCK"), os.Getenv("RFORK_PROTOCOL_REPORT"), os.Getenv("RFORK_PROTOCOL_FOLDER")
	if email == "" || password == "" || stock == "" || reportPath == "" || !regexp.MustCompile(`^rfork-protocol-[a-f0-9]{32}$`).MatchString(folder) {
		t.Fatal("missing protocol-probe configuration")
	}
	raw, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal("missing cleanup receipt")
	}
	report := map[string]any{}
	if json.Unmarshal(raw, &report) != nil || report["remoteFolder"] != folder {
		t.Fatal("invalid cleanup receipt")
	}
	t.Cleanup(func() {
		report["status"] = "passed"
		if t.Failed() {
			report["status"] = "failed"
		}
		data, err := json.MarshalIndent(report, "", "  ")
		if err != nil || os.WriteFile(reportPath, append(data, '\n'), 0600) != nil {
			t.Error("could not save protocol report")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	report["stage"] = "login"
	m := New().SetClient(&http.Client{Timeout: 45 * time.Second})
	m.SetRetries(2)
	m.SetHTTPS(true)
	m.SetLogger(nil)
	m.SetDebugger(nil)
	if m.MultiFactorLogin(email, password, "") != nil {
		t.Fatal("dedicated-account login failed; details withheld")
	}
	report["stage"] = "create-folder"
	parent, err := m.CreateDir(folder, m.FS.GetRoot())
	if err != nil {
		t.Fatal("isolated protocol folder creation failed; details withheld")
	}
	obscure := exec.CommandContext(ctx, stock, "obscure", "-")
	obscure.Stdin = strings.NewReader(password + "\n")
	obscure.Env = protocolStockEnv()
	encoded, err := obscure.Output()
	if err != nil {
		t.Fatal("stock verifier credential setup failed")
	}
	env := append(protocolStockEnv(), "RCLONE_CONFIG=notfound", "RCLONE_CONFIG_RFORKPROTO_TYPE=mega", "RCLONE_CONFIG_RFORKPROTO_USER="+email, "RCLONE_CONFIG_RFORKPROTO_PASS="+strings.TrimSpace(string(encoded)))
	verify := func(name string, plain []byte) {
		t.Helper()
		dest := filepath.Join(t.TempDir(), "download.bin")
		cmd := exec.CommandContext(ctx, stock, "copyto", "rforkproto:"+folder+"/"+name, dest, "--retries", "1", "--low-level-retries", "1", "--mega-use-https=true", "--timeout", "60s", "--contimeout", "20s")
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		if cmd.Run() != nil {
			t.Fatal("independent download failed; backend output withheld")
		}
		data, err := os.ReadFile(dest)
		if err != nil || sha256.Sum256(data) != sha256.Sum256(plain) {
			t.Fatal("independent download SHA-256 mismatch")
		}
	}
	plain := make([]byte, 9*1024*1024+31)
	report["stage"] = "batch-upload-and-offset-replay"
	for i := range plain {
		plain[i] = byte(i*23 + 11)
	}
	u, err := m.NewUploadContext(ctx, parent, "batched.bin", int64(len(plain)), true)
	if err != nil {
		t.Fatal("batched upload session creation failed")
	}
	for first := 0; first < u.Chunks(); {
		count, size := 0, 0
		for first+count < u.Chunks() {
			_, next, err := u.ChunkLocation(first + count)
			if err != nil {
				t.Fatal("invalid native chunk layout")
			}
			if count > 0 && size+next > 4*1024*1024 {
				break
			}
			count++
			size += next
		}
		offset, _, err := u.ChunkRangeLocation(first, count)
		if err != nil {
			t.Fatal("invalid batch layout")
		}
		ciphertext := bytes.Clone(plain[offset : offset+int64(size)])
		if u.UploadRangeContext(ctx, first, count, ciphertext) != nil {
			t.Fatal("live multi-chunk request rejected; details withheld")
		}
		if first == 0 {
			response, err := u.sendUploadRequest(ctx, offset, ciphertext)
			report["acceptedOffsetReplay"] = err == nil && len(response) == 0
			if err != nil {
				t.Fatal("accepted nonterminal offset replay rejected; details withheld")
			}
		}
		first += count
	}
	if _, err := u.FinishContext(ctx); err != nil {
		t.Fatal("batched upload finalization failed; outcome may be uncertain")
	}
	report["stage"] = "batch-independent-download"
	verify("batched.bin", plain)
	report["batchIntegrity"] = true
	report["batchTargetBytes"] = 4 * 1024 * 1024
	report["batchPayloadBytes"] = len(plain)
	// Retain the first handle solely to permit cleanup/verification if replay is
	// unsupported. Production recovery cannot assume a lost handle is available.
	plain = []byte("rfork terminal replay probe\n")
	report["stage"] = "terminal-replay"
	u, err = m.NewUploadContext(ctx, parent, "terminal.bin", int64(len(plain)), true)
	if err != nil {
		t.Fatal("terminal probe session creation failed")
	}
	ciphertext := bytes.Clone(plain)
	if u.UploadRangeContext(ctx, 0, 1, ciphertext) != nil {
		t.Fatal("terminal probe upload failed")
	}
	replayed, err := u.sendUploadRequest(ctx, 0, ciphertext)
	report["terminalReplayReturnedHandle"] = err == nil && len(replayed) > 0
	if err == nil && len(replayed) > 0 {
		u.completion_handle = replayed
	}
	if _, err := u.FinishContext(ctx); err != nil {
		t.Fatal("terminal probe finalization failed; outcome may be uncertain")
	}
	report["stage"] = "terminal-independent-download"
	verify("terminal.bin", plain)
	report["terminalIntegrity"] = true
	report["stage"] = "complete"
}

func protocolStockEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "RCLONE_") || strings.HasPrefix(key, "RFORK_MEGA_") || strings.HasPrefix(key, "X_MEGA_") {
			continue
		}
		env = append(env, entry)
	}
	return env
}
