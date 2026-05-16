export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analysis_reports: {
        Row: {
          created_at: string
          id: string
          policy_name: string
          source_file_url: string | null
          status: string
          summary_json: Json | null
          title: string
        }
        Insert: {
          created_at?: string
          id?: string
          policy_name: string
          source_file_url?: string | null
          status?: string
          summary_json?: Json | null
          title: string
        }
        Update: {
          created_at?: string
          id?: string
          policy_name?: string
          source_file_url?: string | null
          status?: string
          summary_json?: Json | null
          title?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          report_id: string
          role: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          report_id: string
          role: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          report_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "analysis_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      regulatory_changes: {
        Row: {
          change_summary: string | null
          chapter_ref: string
          compared_against: string[]
          created_at: string
          diff_source: string
          id: string
          impact: string
          legal_refs: string[]
          new_requirement: string | null
          old_requirement: string | null
          pages: string | null
          position: number
          related_instruments: string[]
          report_id: string
          tone_shift: string | null
        }
        Insert: {
          change_summary?: string | null
          chapter_ref: string
          compared_against?: string[]
          created_at?: string
          diff_source?: string
          id?: string
          impact?: string
          legal_refs?: string[]
          new_requirement?: string | null
          old_requirement?: string | null
          pages?: string | null
          position?: number
          related_instruments?: string[]
          report_id: string
          tone_shift?: string | null
        }
        Update: {
          change_summary?: string | null
          chapter_ref?: string
          compared_against?: string[]
          created_at?: string
          diff_source?: string
          id?: string
          impact?: string
          legal_refs?: string[]
          new_requirement?: string | null
          old_requirement?: string | null
          pages?: string | null
          position?: number
          related_instruments?: string[]
          report_id?: string
          tone_shift?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "regulatory_changes_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "analysis_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      sop_documents: {
        Row: {
          created_at: string
          doc_type: string
          file_url: string | null
          id: string
          summary: string | null
          tags: string[]
          title: string
          version: string
        }
        Insert: {
          created_at?: string
          doc_type?: string
          file_url?: string | null
          id?: string
          summary?: string | null
          tags?: string[]
          title: string
          version?: string
        }
        Update: {
          created_at?: string
          doc_type?: string
          file_url?: string | null
          id?: string
          summary?: string | null
          tags?: string[]
          title?: string
          version?: string
        }
        Relationships: []
      }
      sop_impacts: {
        Row: {
          change_type: string
          chapter: string | null
          created_at: string
          edited_text: string | null
          find_text: string | null
          id: string
          line_range: string | null
          page: number | null
          paragraph: string | null
          position: number
          replace_text: string | null
          report_id: string
          sop_id: string | null
          sop_title: string
          status: string
          warning: string | null
        }
        Insert: {
          change_type?: string
          chapter?: string | null
          created_at?: string
          edited_text?: string | null
          find_text?: string | null
          id?: string
          line_range?: string | null
          page?: number | null
          paragraph?: string | null
          position?: number
          replace_text?: string | null
          report_id: string
          sop_id?: string | null
          sop_title: string
          status?: string
          warning?: string | null
        }
        Update: {
          change_type?: string
          chapter?: string | null
          created_at?: string
          edited_text?: string | null
          find_text?: string | null
          id?: string
          line_range?: string | null
          page?: number | null
          paragraph?: string | null
          position?: number
          replace_text?: string | null
          report_id?: string
          sop_id?: string | null
          sop_title?: string
          status?: string
          warning?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sop_impacts_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "analysis_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sop_impacts_sop_id_fkey"
            columns: ["sop_id"]
            isOneToOne: false
            referencedRelation: "sop_documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
