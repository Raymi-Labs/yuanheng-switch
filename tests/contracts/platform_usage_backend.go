// Run from a local meta-api checkout, with the fixture filename as the sole argument:
// go run /path/to/client/tests/contracts/platform_usage_backend.go /path/to/client/tests/fixtures/platform-usage-settlement.json
// Uses only an in-memory SQLite database and the real self-usage controller.
package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

type response struct {
	Success bool
	Summary model.DashboardUsageSummary
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) != 2 {
		panic("expected the synthetic settlement fixture filename")
	}
	content, err := os.ReadFile(os.Args[1])
	must(err)
	var fixture struct {
		AccountID string `json:"accountId"`
		Events    []model.Log
		Cases     []struct {
			Name     string
			Response response
		}
	}
	must(common.Unmarshal(content, &fixture))
	owner, err := strconv.Atoi(fixture.AccountID)
	must(err)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	must(err)
	sqlDB, err := db.DB()
	must(err)
	defer sqlDB.Close()
	must(db.AutoMigrate(&model.Log{}))
	model.LOG_DB = db
	for _, row := range fixture.Events {
		must(db.Create(&row).Error)
	}
	gin.SetMode(gin.TestMode)
	for _, item := range fixture.Cases {
		want := item.Response.Summary
		w := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(w)
		url := fmt.Sprintf("/api/data/self?start_timestamp=%d&end_timestamp=%d&user_id=418&username=other", want.StartTimestamp, want.EndTimestamp)
		ctx.Request = httptest.NewRequest(http.MethodGet, url, nil)
		ctx.Set("id", owner)
		controller.GetUserQuotaDates(ctx)
		var body response
		must(common.Unmarshal(w.Body.Bytes(), &body))
		got := body.Summary
		if w.Code != 200 || !body.Success || got.Quota != want.Quota || got.Requests != want.Requests || got.Tokens != want.Tokens || got.Source != want.Source || got.StartTimestamp != want.StartTimestamp || got.EndTimestamp != want.EndTimestamp {
			panic(fmt.Sprintf("%s: expected quota=%d requests=%d tokens=%d; got HTTP %d %s", item.Name, want.Quota, want.Requests, want.Tokens, w.Code, w.Body.String()))
		}
		fmt.Printf("PASS %s: quota=%d requests=%d tokens=%d\n", item.Name, got.Quota, got.Requests, got.Tokens)
	}
}
