package dbexec

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"aid-updater/internal/config"
)

func TestBuildDBCommandUsesEphemeralClientForExternalDockerMySQL(t *testing.T) {
	db := config.Database{
		Password:      "databaseSecret",
		ClientImage:   "mysql:5.7",
		DockerNetwork: "host",
	}
	cmd := buildDBCommand(db, "mysql", "--host", "db.internal", "--port", "3306")
	joined := strings.Join(cmd.Args, " ")
	for _, expected := range []string{"docker run", "--rm", "--network host", "mysql:5.7 mysql", "--host db.internal"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("command is missing %q: %s", expected, joined)
		}
	}
	if strings.Contains(joined, db.Password) {
		t.Fatalf("database password leaked into command arguments: %s", joined)
	}
}

func TestBuildDBCommandPrefersInternalContainer(t *testing.T) {
	db := config.Database{Password: "rootSecret", ExecContainer: "aid-mysql", ClientImage: "mysql:5.7"}
	cmd := buildDBCommand(db, "mysqldump", "aid")
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "docker exec -i -e MYSQL_PWD aid-mysql mysqldump aid") {
		t.Fatalf("unexpected internal database command: %s", joined)
	}
}

func TestMigrationScriptOrderFollowsReleaseSemver(t *testing.T) {
	scripts := []string{
		"v2.1.0.sql",
		"v1.0.0.sql",
		"v1.0.0-rc.2.sql",
		"v1.0.0-beta.10.sql",
		"v1.0.1.sql",
		"v1.0.0-beta.2.sql",
	}
	sort.SliceStable(scripts, func(i, j int) bool {
		return migrationScriptLess(scripts[i], scripts[j])
	})
	want := []string{
		"v1.0.0-beta.2.sql",
		"v1.0.0-beta.10.sql",
		"v1.0.0-rc.2.sql",
		"v1.0.0.sql",
		"v1.0.1.sql",
		"v2.1.0.sql",
	}
	for index := range want {
		if scripts[index] != want[index] {
			t.Fatalf("unexpected migration order at %d: got %q want %q (all=%v)", index, scripts[index], want[index], scripts)
		}
	}
}

func TestMigrationScriptOrderKeepsLegacyNamesAfterVersionedScripts(t *testing.T) {
	scripts := []string{"custom.sql", "v1.0.0.sql", "v1.0.0-beta.1.sql"}
	sort.SliceStable(scripts, func(i, j int) bool {
		return migrationScriptLess(scripts[i], scripts[j])
	})
	want := []string{"v1.0.0-beta.1.sql", "v1.0.0.sql", "custom.sql"}
	for index := range want {
		if scripts[index] != want[index] {
			t.Fatalf("unexpected migration order: got %v want %v", scripts, want)
		}
	}
}

func TestPlanUpgradeUsesInstalledVersionWhenHistoryIsEmpty(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		"v2.2.4.sql", "v3.0.0-beta.1.sql", "v3.0.0.sql", "v3.0.1.sql",
		"v3.0.2.sql", "custom.sql", "README.md",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, tt := range []struct {
		name, source, target string
		want                 []string
	}{
		{"fresh install missing history", "3.0.0", "3.0.1", []string{"v3.0.1.sql", "custom.sql"}},
		{"multi-version upgrade", "2.2.4", "3.0.1", []string{"v3.0.0-beta.1.sql", "v3.0.0.sql", "v3.0.1.sql", "custom.sql"}},
		{"promote prerelease", "3.0.0-beta.1", "3.0.0", []string{"v3.0.0.sql", "custom.sql"}},
		{"same-version repair", "3.0.0", "3.0.0", []string{"custom.sql"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := PlanUpgrade(dir, tt.source, tt.target)
			if err != nil || !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("PlanUpgrade = %v, %v; want %v", got, err, tt.want)
			}
		})
	}
}

func TestPlanUpgradeStopsWhenVersionRangeIsUnknown(t *testing.T) {
	dir := t.TempDir()
	for _, versions := range [][2]string{{"", "3.0.1"}, {"3.0.0", "unknown"}, {"3.0.1", "3.0.0"}} {
		if got, err := PlanUpgrade(dir, versions[0], versions[1]); err == nil || len(got) != 0 {
			t.Fatalf("PlanUpgrade(%s, %s) = %v, %v; want an error", versions[0], versions[1], got, err)
		}
	}
}
